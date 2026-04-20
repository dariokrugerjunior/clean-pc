import { scanTarget } from './scanner.js';
import { cleanTarget } from './cleaner.js';
import { resolveTargets, DEFAULT_TARGET_KEYS } from './targets.js';
import type { ScanResult, CleanResult } from './types.js';

export interface ScanReport {
  results: ScanResult[];
  totalBytes: number;
  totalFiles: number;
  totalEligibleBytes: number;
  totalEligibleFiles: number;
  totalSkippedRecent: number;
  minAgeHours: number;
  durationMs: number;
}

export interface CleanReport {
  results: CleanResult[];
  totalDeletedBytes: number;
  totalDeletedFiles: number;
  totalSkippedRecent: number;
  totalFailed: number;
  dryRun: boolean;
  durationMs: number;
}

export async function runScan(
  minAgeHours = 24,
  targetKeys: string[] = DEFAULT_TARGET_KEYS,
): Promise<ScanReport> {
  const start = performance.now();
  const targets = resolveTargets(targetKeys);

  // Scan all targets concurrently. Each target uses its own scanFn when
  // defined (external targets like recycleBin), otherwise the generic scanner.
  const results = await Promise.all(
    targets.map(t => t.scanFn ? t.scanFn(minAgeHours) : scanTarget(t, minAgeHours)),
  );

  return {
    results,
    totalBytes:         results.reduce((a, r) => a + r.totalBytes, 0),
    totalFiles:         results.reduce((a, r) => a + r.fileCount, 0),
    totalEligibleBytes: results.reduce((a, r) => a + r.eligibleBytes, 0),
    totalEligibleFiles: results.reduce((a, r) => a + r.eligibleCount, 0),
    totalSkippedRecent: results.reduce((a, r) => a + r.skippedRecentCount, 0),
    minAgeHours,
    durationMs: Math.round(performance.now() - start),
  };
}

export async function runClean(
  scanReport: ScanReport,
  dryRun: boolean,
  targetKeys: string[] = DEFAULT_TARGET_KEYS,
): Promise<CleanReport> {
  const start = performance.now();
  const targets = resolveTargets(targetKeys);

  // Clean sequentially. Match each target to its scan result by targetKey.
  // If a target's scan result is missing (e.g. it errored out), skip it.
  const cleanResults: CleanResult[] = [];
  for (const target of targets) {
    const scanResult = scanReport.results.find(r => r.targetKey === target.key);
    if (!scanResult) continue;

    // Skip targets whose scan failed completely (error + no bytes)
    if (scanResult.error && scanResult.eligibleBytes === 0 && scanResult.eligibleCount === 0) {
      continue;
    }

    const result = target.cleanFn
      ? await target.cleanFn(scanResult, dryRun)
      : await cleanTarget(target, scanResult, dryRun);

    cleanResults.push(result);
  }

  return {
    results: cleanResults,
    totalDeletedBytes:  cleanResults.reduce((a, r) => a + r.deletedBytes, 0),
    totalDeletedFiles:  cleanResults.reduce((a, r) => a + r.deletedCount, 0),
    totalSkippedRecent: cleanResults.reduce((a, r) => a + r.skippedRecentCount, 0),
    totalFailed:        cleanResults.reduce((a, r) => a + r.failedFiles.length, 0),
    dryRun,
    durationMs: Math.round(performance.now() - start),
  };
}
