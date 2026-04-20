import { normalize } from 'path';
import type { TargetDef, ScanResult, CleanResult } from './types.js';
import { safeRemove } from './safety/safe-remove.js';

function validatePaths(files: ScanResult['files'], allowedBase: string): void {
  const base = normalize(allowedBase).toLowerCase();
  for (const file of files) {
    if (!normalize(file.path).toLowerCase().startsWith(base)) {
      throw new Error(`Security: path escapes allowed base directory: ${file.path}`);
    }
  }
}

export async function cleanTarget(
  target: TargetDef,
  scanResult: ScanResult,
  dryRun: boolean,
): Promise<CleanResult> {
  const start = performance.now();
  const allowedBase = target.resolvePath();

  validatePaths(scanResult.files, allowedBase);

  let deletedBytes = 0;
  let deletedCount = 0;
  let skippedRecentCount = 0;
  const failedFiles: CleanResult['failedFiles'] = [];

  for (const file of scanResult.files) {
    if (file.tooRecent) {
      skippedRecentCount++;
      continue;
    }

    const result = await safeRemove(file.path, dryRun);
    if (result.success) {
      deletedBytes += file.sizeBytes;
      deletedCount++;
    } else if (result.error) {
      failedFiles.push({ path: file.path, error: result.error });
    }
  }

  return {
    targetKey: target.key,
    label: scanResult.label,
    isExternal: false,
    deletedBytes,
    deletedCount,
    skippedRecentCount,
    failedFiles,
    durationMs: Math.round(performance.now() - start),
    dryRun,
  };
}
