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

// ─── Multi-directory scan helpers ─────────────────────────────────────────────

function toGlobPath(p: string): string {
  return normalize(p).replace(/\\/g, '/');
}

/** Scan a single directory with specific glob patterns and age filtering. */
async function scanDirWithPatterns(
  baseDir: string,
  patterns: string[],
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
  const globPatterns = patterns.map(p => `${globBase}/${p}`);

  let paths: string[];
  try {
    paths = await fg(globPatterns, {
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

/** Stat a single specific file (not a glob). Returns null if inaccessible or a symlink. */
async function statSingleFile(filePath: string, cutoff: Date): Promise<ScannedFile | null> {
  try {
    const stat = await fs.lstat(filePath);
    if (stat.isSymbolicLink() || !stat.isFile()) return null;
    return {
      path: normalize(filePath),
      sizeBytes: stat.size,
      modifiedAt: stat.mtime,
      tooRecent: stat.mtime > cutoff,
    };
  } catch {
    return null;
  }
}

/** Generic multi-location scan: many directories + optional specific files. */
async function scanMultiLocation(
  targetKey: string,
  label: string,
  riskLevel: 'safe' | 'moderate' | 'aggressive',
  dirs: string[],
  patterns: string[],
  singleFiles: string[],
  minAgeHours: number,
): Promise<ScanResult> {
  const start = performance.now();
  const cutoff = new Date(Date.now() - minAgeHours * 60 * 60 * 1000);

  const allFiles: ScannedFile[] = [];
  const errors: string[] = [];

  const dirResults = await Promise.all(dirs.map(dir => scanDirWithPatterns(dir, patterns, cutoff)));
  for (let i = 0; i < dirResults.length; i++) {
    const { files, accessError } = dirResults[i]!;
    allFiles.push(...files);
    if (accessError && accessError !== 'not found') {
      errors.push(`${dirs[i]}: ${accessError}`);
    }
  }

  for (const filePath of singleFiles) {
    const f = await statSingleFile(filePath, cutoff);
    if (f) allFiles.push(f);
  }

  const totalBytes = allFiles.reduce((a, f) => a + f.sizeBytes, 0);
  const eligible = allFiles.filter(f => !f.tooRecent);

  return {
    targetKey,
    label,
    riskLevel,
    isExternal: false,
    files: allFiles,
    totalBytes,
    fileCount: allFiles.length,
    eligibleBytes: eligible.reduce((a, f) => a + f.sizeBytes, 0),
    eligibleCount: eligible.length,
    skippedRecentCount: allFiles.length - eligible.length,
    durationMs: Math.round(performance.now() - start),
    error: errors.length > 0 ? errors.join(' | ') : undefined,
  };
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

// ─── Crash Dumps ─────────────────────────────────────────────────────────────

const CRASH_DUMP_PATTERNS = ['**/*.dmp', '**/*.mdmp', '**/*.hdmp'];

function getCrashDumpDirs(): string[] {
  const local = process.env['LOCALAPPDATA'] ?? join(os.homedir(), 'AppData', 'Local');
  return [
    join(local, 'CrashDumps'),
    'C:\\Windows\\Minidump',
    'C:\\Windows\\LiveKernelReports',
  ];
}

// Kernel dumps that live at a fixed path (not inside a directory we globbed).
const CRASH_DUMP_SINGLE_FILES = ['C:\\Windows\\memory.dmp'];

// ─── Shader Cache ────────────────────────────────────────────────────────────

// Shader cache dirs are single-purpose — everything inside is a regenerable blob.
// Vendors use inconsistent naming (.dxcache, .parc, extensionless), so match all files.
const SHADER_CACHE_PATTERNS = ['**/*'];

function getShaderCacheDirs(): string[] {
  const local = process.env['LOCALAPPDATA'] ?? join(os.homedir(), 'AppData', 'Local');
  return [
    join(local, 'D3DSCache'),          // DirectX built-in
    join(local, 'NVIDIA', 'DXCache'),  // NVIDIA DirectX
    join(local, 'NVIDIA', 'GLCache'),  // NVIDIA OpenGL
    join(local, 'AMD', 'DxCache'),     // AMD/Radeon DirectX
  ];
}

// ─── Thumbnail Cache ─────────────────────────────────────────────────────────

// Files live directly in Explorer/ — no ** prefix so we don't touch nested state.
const THUMBNAIL_CACHE_PATTERNS = ['thumbcache_*.db', 'iconcache_*.db'];

function getThumbnailCacheDirs(): string[] {
  const local = process.env['LOCALAPPDATA'] ?? join(os.homedir(), 'AppData', 'Local');
  return [join(local, 'Microsoft', 'Windows', 'Explorer')];
}

// ─── Docker helpers ──────────────────────────────────────────────────────────

// Docker prints human-readable sizes like "18.81GB (64%)" / "112.8MB" / "6.266GB".
// Returns bytes, or 0 if the value is missing / unparseable.
function parseDockerSize(raw: string | undefined): number {
  if (!raw) return 0;
  const m = raw.match(/([\d.]+)\s*(B|KB|MB|GB|TB|KiB|MiB|GiB|TiB)/i);
  if (!m) return 0;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return 0;
  const unit = m[2]!.toUpperCase();
  const mult: Record<string, number> = {
    B: 1,
    KB: 1_000, MB: 1_000_000, GB: 1_000_000_000, TB: 1_000_000_000_000,
    KIB: 1024, MIB: 1024 ** 2, GIB: 1024 ** 3, TIB: 1024 ** 4,
  };
  return Math.round(n * (mult[unit] ?? 0));
}

/** Distinguish "CLI missing" from "daemon offline" for clearer scan error output. */
function classifyDockerError(err: unknown): string {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === 'ENOENT') return 'Docker CLI not found in PATH';
  const msg = String((err as Error).message ?? err);
  if (/daemon|pipe|connect/i.test(msg)) return 'Docker daemon not running';
  return `Docker command failed: ${msg.split('\n')[0]}`;
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
      return scanMultiLocation('logs', 'Log Files', 'moderate', getLogDirs(), LOG_PATTERNS, [], minAgeHours);
    },

    async cleanFn(scanResult: ScanResult, dryRun: boolean): Promise<CleanResult> {
      return deleteFiles('logs', scanResult, getLogDirs(), dryRun, performance.now());
    },
  },

  // Windows Update download cache. `SoftwareDistribution\Download` is the
  // documented safe target — parent `SoftwareDistribution` also contains
  // runtime state (DataStore) that must not be touched. Files locked by
  // the wuauserv service fail gracefully in safeRemove; run as admin (and
  // ideally stop wuauserv first) to reclaim the last few GBs.
  windowsUpdate: {
    key: 'windowsUpdate',
    label: 'Windows Update Cache',
    resolvePath: () => 'C:\\Windows\\SoftwareDistribution\\Download',
    riskLevel: 'moderate',
  },

  // Crash / minidump files across per-user, kernel-minidump and full-kernel-dump paths.
  // Deleting a .dmp only removes post-mortem debugging data; nothing at runtime depends on it.
  crashDumps: {
    key: 'crashDumps',
    label: 'Crash Dumps',
    resolvePath: () => '', // multi-location target
    riskLevel: 'safe',

    async scanFn(minAgeHours: number): Promise<ScanResult> {
      return scanMultiLocation(
        'crashDumps',
        'Crash Dumps',
        'safe',
        getCrashDumpDirs(),
        CRASH_DUMP_PATTERNS,
        CRASH_DUMP_SINGLE_FILES,
        minAgeHours,
      );
    },

    async cleanFn(scanResult: ScanResult, dryRun: boolean): Promise<CleanResult> {
      // Each single-file path acts as its own allowed base (deleteFiles uses startsWith).
      const bases = [...getCrashDumpDirs(), ...CRASH_DUMP_SINGLE_FILES];
      return deleteFiles('crashDumps', scanResult, bases, dryRun, performance.now());
    },
  },

  // Windows Update peer-to-peer download cache. Same parent as `windowsUpdate`,
  // but a distinct subdirectory — reclaiming it does not affect update history.
  deliveryOptimization: {
    key: 'deliveryOptimization',
    label: 'Delivery Optimization',
    resolvePath: () => 'C:\\Windows\\SoftwareDistribution\\DeliveryOptimization',
    riskLevel: 'moderate',
  },

  // GPU shader binary caches — DirectX (built-in) + NVIDIA + AMD. Shaders are
  // recompiled on demand the next time a game/app runs; only stalls the *first*
  // frames after cleanup.
  shaderCache: {
    key: 'shaderCache',
    label: 'GPU Shader Cache',
    resolvePath: () => '', // multi-location target
    riskLevel: 'safe',

    async scanFn(minAgeHours: number): Promise<ScanResult> {
      return scanMultiLocation(
        'shaderCache',
        'GPU Shader Cache',
        'safe',
        getShaderCacheDirs(),
        SHADER_CACHE_PATTERNS,
        [],
        minAgeHours,
      );
    },

    async cleanFn(scanResult: ScanResult, dryRun: boolean): Promise<CleanResult> {
      return deleteFiles('shaderCache', scanResult, getShaderCacheDirs(), dryRun, performance.now());
    },
  },

  // Explorer thumbnail + icon caches. Regenerate transparently on the next
  // folder view. Files can be locked while Explorer is running.
  thumbnailCache: {
    key: 'thumbnailCache',
    label: 'Thumbnail Cache',
    resolvePath: () => '', // pattern-scoped inside a well-known dir
    riskLevel: 'safe',

    async scanFn(minAgeHours: number): Promise<ScanResult> {
      return scanMultiLocation(
        'thumbnailCache',
        'Thumbnail Cache',
        'safe',
        getThumbnailCacheDirs(),
        THUMBNAIL_CACHE_PATTERNS,
        [],
        minAgeHours,
      );
    },

    async cleanFn(scanResult: ScanResult, dryRun: boolean): Promise<CleanResult> {
      return deleteFiles('thumbnailCache', scanResult, getThumbnailCacheDirs(), dryRun, performance.now());
    },
  },

  // Docker: unused images + build cache + stopped containers. Volumes are
  // *not* touched — that's a separate call to `docker system prune --volumes`
  // and destroys dev DB state, which merits a separate (aggressive) target.
  // The VHDX file itself doesn't shrink until you compact it (diskpart /
  // Optimize-VHD), which requires admin — out of scope for this target.
  docker: {
    key: 'docker',
    label: 'Docker (unused)',
    resolvePath: () => '', // external — no filesystem path
    riskLevel: 'moderate',

    async scanFn(_minAgeHours: number): Promise<ScanResult> {
      const start = performance.now();
      const empty = (error?: string): ScanResult => ({
        targetKey: 'docker',
        label: 'Docker (unused)',
        riskLevel: 'moderate',
        isExternal: true,
        files: [],
        totalBytes: 0,
        fileCount: 0,
        eligibleBytes: 0,
        eligibleCount: 0,
        skippedRecentCount: 0,
        durationMs: Math.round(performance.now() - start),
        error,
      });

      let stdout: string;
      try {
        const r = await execa('docker', ['system', 'df', '--format', 'json'], { timeout: 15_000 });
        stdout = r.stdout;
      } catch (err) {
        return empty(classifyDockerError(err));
      }

      let totalBytes = 0;
      let eligibleBytes = 0;
      for (const line of stdout.split(/\r?\n/).map(l => l.trim()).filter(Boolean)) {
        try {
          const row = JSON.parse(line) as { Type?: string; Size?: string; Reclaimable?: string };
          totalBytes += parseDockerSize(row.Size);
          // Volumes intentionally excluded — we're not passing --volumes to prune.
          if (row.Type && row.Type !== 'Local Volumes') {
            eligibleBytes += parseDockerSize(row.Reclaimable);
          }
        } catch { /* skip malformed row */ }
      }

      return {
        targetKey: 'docker',
        label: 'Docker (unused)',
        riskLevel: 'moderate',
        isExternal: true,
        files: [],
        totalBytes,
        fileCount: 0,
        eligibleBytes,
        eligibleCount: 0,
        skippedRecentCount: 0,
        durationMs: Math.round(performance.now() - start),
      };
    },

    async cleanFn(scanResult: ScanResult, dryRun: boolean): Promise<CleanResult> {
      const start = performance.now();

      if (dryRun) {
        return {
          targetKey: 'docker',
          label: scanResult.label,
          isExternal: true,
          deletedBytes: scanResult.eligibleBytes,
          deletedCount: 0,
          skippedRecentCount: 0,
          failedFiles: [],
          durationMs: Math.round(performance.now() - start),
          dryRun,
        };
      }

      let stdout: string;
      try {
        const r = await execa('docker', ['system', 'prune', '-a', '--force'], { timeout: 600_000 });
        stdout = r.stdout;
      } catch (err) {
        return {
          targetKey: 'docker',
          label: scanResult.label,
          isExternal: true,
          deletedBytes: 0,
          deletedCount: 0,
          skippedRecentCount: 0,
          failedFiles: [{ path: 'docker system prune', error: classifyDockerError(err) }],
          durationMs: Math.round(performance.now() - start),
          dryRun,
        };
      }

      // "Total reclaimed space: 33.04GB" — Docker's canonical last line.
      const m = stdout.match(/Total reclaimed space:\s*([\d.]+\s*(?:B|KB|MB|GB|TB|KiB|MiB|GiB|TiB))/i);
      const deletedBytes = m ? parseDockerSize(m[1]) : scanResult.eligibleBytes;

      return {
        targetKey: 'docker',
        label: scanResult.label,
        isExternal: true,
        deletedBytes,
        deletedCount: 0,
        skippedRecentCount: 0,
        failedFiles: [],
        durationMs: Math.round(performance.now() - start),
        dryRun,
      };
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
