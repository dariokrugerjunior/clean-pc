import fs from 'fs/promises';
import { normalize } from 'path';
import fg from 'fast-glob';
import pLimit from 'p-limit';
import type { TargetDef, ScanResult, ScannedFile } from './types.js';

function toGlobPath(p: string): string {
  return normalize(p).replace(/\\/g, '/');
}

export async function scanTarget(target: TargetDef, minAgeHours: number): Promise<ScanResult> {
  const start = performance.now();
  const baseDir = target.resolvePath();
  const cutoff = new Date(Date.now() - minAgeHours * 60 * 60 * 1000);

  const empty = (error?: string): ScanResult => ({
    targetKey: target.key,
    label: target.label,
    riskLevel: target.riskLevel,
    isExternal: false,
    files: [],
    totalBytes: 0,
    fileCount: 0,
    eligibleBytes: 0,
    eligibleCount: 0,
    skippedRecentCount: 0,
    durationMs: Math.round(performance.now() - start),
    error,
  });

  try {
    await fs.access(baseDir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EACCES' || code === 'EPERM') {
      return empty('Requires administrator privileges');
    }
    return empty(`Directory not found: ${baseDir}`);
  }

  let paths: string[];
  try {
    paths = await fg(`${toGlobPath(baseDir)}/**/*`, {
      onlyFiles: true,
      dot: true,
      followSymbolicLinks: false,
      suppressErrors: true,
    });
  } catch (err) {
    return empty(`Glob failed: ${String(err)}`);
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

  const files = settled.filter((f): f is ScannedFile => f !== null);
  const totalBytes = files.reduce((acc, f) => acc + f.sizeBytes, 0);
  const eligible = files.filter(f => !f.tooRecent);

  return {
    targetKey: target.key,
    label: target.label,
    riskLevel: target.riskLevel,
    isExternal: false,
    files,
    totalBytes,
    fileCount: files.length,
    eligibleBytes: eligible.reduce((acc, f) => acc + f.sizeBytes, 0),
    eligibleCount: eligible.length,
    skippedRecentCount: files.length - eligible.length,
    durationMs: Math.round(performance.now() - start),
  };
}
