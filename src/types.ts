export type RiskLevel = 'safe' | 'moderate' | 'aggressive';

export interface TargetDef {
  /** Unique identifier used in CLI flags and reports. */
  key: string;
  /** Human-readable name shown in reports. */
  label: string;
  /** Resolves the absolute base directory at runtime. Not used by external targets. */
  resolvePath(): string;
  riskLevel: RiskLevel;
  /**
   * Optional override for targets that cannot use the generic file scanner
   * (e.g. Recycle Bin, Docker). When present, the orchestrator calls this
   * instead of scanTarget().
   */
  scanFn?: (minAgeHours: number) => Promise<ScanResult>;
  /**
   * Optional override for targets that cannot use the generic file cleaner.
   * When present, the orchestrator calls this instead of cleanTarget().
   */
  cleanFn?: (scanResult: ScanResult, dryRun: boolean) => Promise<CleanResult>;
}

export interface ScannedFile {
  path: string;
  sizeBytes: number;
  modifiedAt: Date;
  tooRecent: boolean;
}

export interface ScanResult {
  targetKey: string;
  label: string;
  riskLevel: RiskLevel;
  /**
   * True for targets that use external commands (Recycle Bin, Docker).
   * These produce no individual file list — only aggregate size.
   */
  isExternal: boolean;
  files: ScannedFile[];
  totalBytes: number;
  fileCount: number;
  eligibleBytes: number;
  eligibleCount: number;
  skippedRecentCount: number;
  durationMs: number;
  error?: string;
}

export interface CleanResult {
  targetKey: string;
  label: string;
  isExternal: boolean;
  deletedBytes: number;
  deletedCount: number;
  skippedRecentCount: number;
  failedFiles: Array<{ path: string; error: string }>;
  durationMs: number;
  dryRun: boolean;
}
