import os from 'os';
import fs from 'fs/promises';
import { join, normalize } from 'path';
import fg from 'fast-glob';
import pLimit from 'p-limit';
import { execa } from 'execa';
import { scanTarget } from './scanner.js';
import { safeRemove } from './safety/safe-remove.js';
import type { TargetDef, ScanResult, CleanResult, ScannedFile } from './types.js';

// ─── Shared helper ────────────────────────────────────────────────────────────

/**
 * Generic file-by-file deletion with multi-base TOCTOU validation.
 * Used by npm (fallback) and logs (primary).
 */
async function deleteFiles(
  targetKey: string,
  scanResult: ScanResult,
  allowedBases: string[],
  dryRun: boolean,
  startTime: number,
): Promise<CleanResult> {
  const normalizedBases = allowedBases.map(b => normalize(b).toLowerCase());

  for (const file of scanResult.files) {
    const n = normalize(file.path).toLowerCase();
    if (!normalizedBases.some(base => n.startsWith(base))) {
      throw new Error(`Security: path escapes allowed bases: ${file.path}`);
    }
  }

  let deletedBytes = 0;
  let deletedCount = 0;
  let skippedRecentCount = 0;
  const failedFiles: CleanResult['failedFiles'] = [];

  for (const file of scanResult.files) {
    if (file.tooRecent) { skippedRecentCount++; continue; }
    const r = await safeRemove(file.path, dryRun);
    if (r.success) { deletedBytes += file.sizeBytes; deletedCount++; }
    else if (r.error) failedFiles.push({ path: file.path, error: r.error });
  }

  return {
    targetKey,
    label: scanResult.label,
    isExternal: false,
    deletedBytes,
    deletedCount,
    skippedRecentCount,
    failedFiles,
    durationMs: Math.round(performance.now() - startTime),
    dryRun,
  };
}

// ─── Recycle Bin ─────────────────────────────────────────────────────────────

async function queryRecycleBinBytes(): Promise<number> {
  const ps = [
    '-NoProfile', '-NonInteractive', '-Command',
    '$s=(New-Object -ComObject Shell.Application).NameSpace(10);' +
    '$t=0L;' +
    '$s.Items()|ForEach-Object{try{$t+=[long]$_.ExtendedProperty("System.Size")}catch{}};' +
    '$t',
  ];
  const { stdout } = await execa('powershell', ps, { timeout: 15_000 });
  const n = Number(stdout.trim());
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

async function emptyRecycleBin(): Promise<void> {
  await execa('powershell', [
    '-NoProfile', '-NonInteractive', '-Command',
    'Clear-RecycleBin -Force -ErrorAction SilentlyContinue',
  ], { timeout: 30_000 });
}

// ─── npm Cache ────────────────────────────────────────────────────────────────

// Cache the resolved path for the session (avoid repeated `npm config get cache` calls).
let _npmCacheDir: string | undefined;

async function resolveNpmCacheDir(): Promise<string> {
  if (_npmCacheDir !== undefined) return _npmCacheDir;
  try {
    const { stdout } = await execa('npm', ['config', 'get', 'cache'], { timeout: 10_000 });
    const p = stdout.trim();
    if (p && p !== 'undefined') {
      _npmCacheDir = p;
      return _npmCacheDir;
    }
  } catch { /* npm not found — fall through to default */ }
  // Fallback: %APPDATA%\npm-cache (npm default on Windows uses Roaming, not Local)
  const appdata = process.env['APPDATA'];
  _npmCacheDir = appdata ? join(appdata, 'npm-cache') : join(os.homedir(), '.npm');
  return _npmCacheDir;
}

// ─── Logs ────────────────────────────────────────────────────────────────────

const LOG_PATTERNS = ['**/*.log', '**/*.tmp', '**/*.dmp'];

function getLogDirs(): string[] {
  const local = process.env['LOCALAPPDATA'] ?? join(os.homedir(), 'AppData', 'Local');
  return [
    join(local, 'Logs'),
    join(local, 'Microsoft', 'Windows', 'WER'),
    'C:\\Windows\\Logs',
    'C:\\ProgramData\\Microsoft\\Windows\\WER',
  ];
}

function toGlobPath(p: string): string {
  return normalize(p).replace(/\\/g, '/');
}

/** Scan a single directory with specific glob patterns and age filtering. */
async function scanLogDir(
  baseDir: string,
  cutoff: Date,
): Promise<{ files: ScannedFile[]; accessError?: string }> {
  try {
    await fs.access(baseDir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    const reason = (code === 'EPERM' || code === 'EACCES') ? 'access denied' : 'not found';
    return { files: [], accessError: reason };
  }

  const globBase = toGlobPath(baseDir);
  const patterns = LOG_PATTERNS.map(p => `${globBase}/${p}`);

  let paths: string[];
  try {
    paths = await fg(patterns, {
      onlyFiles: true,
      dot: true,
      followSymbolicLinks: false,
      suppressErrors: true,
    });
  } catch {
    return { files: [], accessError: 'glob failed' };
  }

  const limit = pLimit(50);
  const settled = await Promise.all(
    paths.map(p =>
      limit(async (): Promise<ScannedFile | null> => {
        try {
          const stat = await fs.lstat(p);
          if (stat.isSymbolicLink()) return null;
          return {
            path: normalize(p),
            sizeBytes: stat.size,
            modifiedAt: stat.mtime,
            tooRecent: stat.mtime > cutoff,
          };
        } catch {
          return null;
        }
      }),
    ),
  );

  return { files: settled.filter((f): f is ScannedFile => f !== null) };
}

// ─── Target registry ─────────────────────────────────────────────────────────

export const ALL_TARGETS: Record<string, TargetDef> = {

  userTemp: {
    key: 'userTemp',
    label: 'User Temp Files',
    resolvePath() {
      const local = process.env['LOCALAPPDATA'];
      return local ? join(local, 'Temp') : (process.env['TEMP'] ?? 'C:\\Windows\\Temp');
    },
    riskLevel: 'safe',
  },

  windowsTemp: {
    key: 'windowsTemp',
    label: 'Windows Temp',
    resolvePath: () => 'C:\\Windows\\Temp',
    riskLevel: 'safe',
    // Uses the generic scanner/cleaner — EPERM handled gracefully in scanner.ts.
  },

  recycleBin: {
    key: 'recycleBin',
    label: 'Recycle Bin',
    resolvePath: () => '', // unused — external target
    riskLevel: 'safe',

    async scanFn(_minAgeHours: number): Promise<ScanResult> {
      const start = performance.now();
      let eligibleBytes = 0;
      let error: string | undefined;
      try {
        eligibleBytes = await queryRecycleBinBytes();
      } catch (err) {
        error = `PowerShell query failed: ${String(err)}`;
      }
      return {
        targetKey: 'recycleBin',
        label: 'Recycle Bin',
        riskLevel: 'safe',
        isExternal: true,
        files: [],
        totalBytes: eligibleBytes,
        fileCount: 0,
        eligibleBytes,
        eligibleCount: 0,
        skippedRecentCount: 0,
        durationMs: Math.round(performance.now() - start),
        error,
      };
    },

    async cleanFn(scanResult: ScanResult, dryRun: boolean): Promise<CleanResult> {
      const start = performance.now();
      if (!dryRun) {
        try {
          await emptyRecycleBin();
        } catch (err) {
          return {
            targetKey: 'recycleBin',
            label: scanResult.label,
            isExternal: true,
            deletedBytes: 0,
            deletedCount: 0,
            skippedRecentCount: 0,
            failedFiles: [{ path: 'Recycle Bin', error: String(err) }],
            durationMs: Math.round(performance.now() - start),
            dryRun,
          };
        }
      }
      return {
        targetKey: 'recycleBin',
        label: scanResult.label,
        isExternal: true,
        deletedBytes: scanResult.eligibleBytes,
        deletedCount: 0,
        skippedRecentCount: 0,
        failedFiles: [],
        durationMs: Math.round(performance.now() - start),
        dryRun,
      };
    },
  },

  npm: {
    key: 'npm',
    label: 'npm Cache',
    resolvePath: () => '', // resolved async in scanFn
    riskLevel: 'moderate',

    async scanFn(minAgeHours: number): Promise<ScanResult> {
      const cacheDir = await resolveNpmCacheDir();
      // Delegate to the generic scanner using the resolved path.
      // A synthetic TargetDef is used so we don't recurse back through scanFn.
      return scanTarget(
        { key: 'npm', label: 'npm Cache', resolvePath: () => cacheDir, riskLevel: 'moderate' },
        minAgeHours,
      );
    },

    async cleanFn(scanResult: ScanResult, dryRun: boolean): Promise<CleanResult> {
      const start = performance.now();

      if (!dryRun) {
        try {
          // Prefer the official command — npm manages its own cache structure safely.
          await execa('npm', ['cache', 'clean', '--force'], { timeout: 60_000 });
          return {
            targetKey: 'npm',
            label: scanResult.label,
            isExternal: false,
            deletedBytes: scanResult.eligibleBytes,
            deletedCount: scanResult.eligibleCount,
            skippedRecentCount: scanResult.skippedRecentCount,
            failedFiles: [],
            durationMs: Math.round(performance.now() - start),
            dryRun,
          };
        } catch { /* npm command failed — fall through to manual deletion */ }
      }

      // Dry-run path or npm command fallback: delete files from the scan result.
      const cacheDir = await resolveNpmCacheDir();
      return deleteFiles('npm', scanResult, [cacheDir], dryRun, start);
    },
  },

  logs: {
    key: 'logs',
    label: 'Log Files',
    resolvePath: () => '', // multi-directory target
    riskLevel: 'moderate',

    async scanFn(minAgeHours: number): Promise<ScanResult> {
      const start = performance.now();
      const cutoff = new Date(Date.now() - minAgeHours * 60 * 60 * 1000);
      const dirs = getLogDirs();

      const allFiles: ScannedFile[] = [];
      const dirErrors: string[] = [];

      // Scan directories concurrently — each is independent.
      const results = await Promise.all(dirs.map(dir => scanLogDir(dir, cutoff)));
      for (let i = 0; i < results.length; i++) {
        const { files, accessError } = results[i]!;
        allFiles.push(...files);
        if (accessError && accessError !== 'not found') {
          dirErrors.push(`${dirs[i]}: ${accessError}`);
        }
      }

      const totalBytes = allFiles.reduce((a, f) => a + f.sizeBytes, 0);
      const eligible = allFiles.filter(f => !f.tooRecent);

      return {
        targetKey: 'logs',
        label: 'Log Files',
        riskLevel: 'moderate',
        isExternal: false,
        files: allFiles,
        totalBytes,
        fileCount: allFiles.length,
        eligibleBytes: eligible.reduce((a, f) => a + f.sizeBytes, 0),
        eligibleCount: eligible.length,
        skippedRecentCount: allFiles.length - eligible.length,
        durationMs: Math.round(performance.now() - start),
        error: dirErrors.length > 0 ? dirErrors.join(' | ') : undefined,
      };
    },

    async cleanFn(scanResult: ScanResult, dryRun: boolean): Promise<CleanResult> {
      return deleteFiles('logs', scanResult, getLogDirs(), dryRun, performance.now());
    },
  },
};

/** Keys active when --targets is not specified. */
export const DEFAULT_TARGET_KEYS = ['userTemp'];

export function resolveTargets(keys: string[]): TargetDef[] {
  return keys.map(key => {
    const def = ALL_TARGETS[key];
    if (!def) {
      throw new Error(`Unknown target: "${key}". Available: ${Object.keys(ALL_TARGETS).join(', ')}`);
    }
    return def;
  });
}
