import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { confirm } from '@inquirer/prompts';
import bytes from 'bytes';
import { runScan, runClean } from '../orchestrator.js';
import type { ScanReport, CleanReport } from '../orchestrator.js';
import { DEFAULT_TARGET_KEYS, ALL_TARGETS } from '../targets.js';

// ─── Formatting ──────────────────────────────────────────────────────────────

const DIVIDER = '─'.repeat(60);

function fmt(n: number): string {
  return bytes(n, { unitSeparator: ' ', decimalPlaces: 2 }) ?? '0 B';
}

const TOP_N = 10;

function truncatePath(p: string, maxLen = 60): string {
  if (p.length <= maxLen) return p;
  const half = Math.floor((maxLen - 3) / 2);
  return `${p.slice(0, half)}...${p.slice(-half)}`;
}

function printTopFiles(report: ScanReport): void {
  // Only eligible (non-recent) files are candidates — show what will actually be cleaned.
  // External targets (recycleBin) have no individual files, skip them here.
  const eligible = report.results.flatMap(r => r.isExternal ? [] : r.files.filter(f => !f.tooRecent));
  const recent   = report.results.flatMap(r => r.isExternal ? [] : r.files.filter(f => f.tooRecent));

  if (eligible.length === 0 && recent.length === 0) return;

  // Top N eligible files by size
  if (eligible.length > 0) {
    const bySize = [...eligible].sort((a, b) => b.sizeBytes - a.sizeBytes).slice(0, TOP_N);
    console.log(chalk.bold(`  Top ${TOP_N} largest eligible files:`));
    for (const f of bySize) {
      const size = chalk.cyan(fmt(f.sizeBytes).padStart(10));
      const path = chalk.dim(truncatePath(f.path));
      console.log(`    ${size}  ${path}`);
    }
    console.log('');
  }

  // Top N most recently modified (across ALL files, including too-recent — informational)
  const allFiles = [...eligible, ...recent];
  const byDate = [...allFiles].sort((a, b) => b.modifiedAt.getTime() - a.modifiedAt.getTime()).slice(0, TOP_N);
  console.log(chalk.bold(`  Top ${TOP_N} most recently modified:`));
  for (const f of byDate) {
    const date  = chalk.yellow(f.modifiedAt.toLocaleString('pt-BR').padEnd(22));
    const guard = f.tooRecent ? chalk.red(' [too recent, skipped]') : '';
    const path  = chalk.dim(truncatePath(f.path));
    console.log(`    ${date}  ${path}${guard}`);
  }
  console.log('');
}

function printScanReport(report: ScanReport): void {
  console.log('');
  console.log(chalk.bold('Scan Results'));
  console.log(chalk.dim(DIVIDER));

  for (const r of report.results) {
    const riskColor = r.riskLevel === 'safe' ? chalk.green : chalk.yellow;
    const badge     = riskColor(`[${r.riskLevel.toUpperCase()}]`).padEnd(20);
    const size      = chalk.cyan(fmt(r.totalBytes).padStart(10));
    const errNote   = r.error ? chalk.yellow(`  ⚠ ${r.error}`) : '';

    if (r.isExternal) {
      // External targets (Recycle Bin, etc.) have no individual file list
      const note = r.eligibleBytes > 0 ? chalk.dim('(estimated via system)') : chalk.dim('(empty)');
      console.log(`  ${badge} ${r.label.padEnd(22)} ${size}  ${note}${errNote}`);
    } else {
      const count = chalk.dim(`(${r.fileCount.toLocaleString()} files found)`);
      console.log(`  ${badge} ${r.label.padEnd(22)} ${size}  ${count}${errNote}`);
      // Eligibility breakdown only for file-system targets
      console.log(
        chalk.dim(
          `    eligible: ${r.eligibleCount.toLocaleString()} files (${fmt(r.eligibleBytes)})` +
          (r.skippedRecentCount > 0
            ? `  ·  skipped (too recent): ${r.skippedRecentCount.toLocaleString()}`
            : ''),
        ),
      );
    }
  }

  console.log(chalk.dim(DIVIDER));
  console.log(
    `  ${'Eligible to free'.padEnd(44)} ${chalk.bold.cyan(fmt(report.totalEligibleBytes).padStart(10))}`,
  );
  if (report.totalSkippedRecent > 0) {
    console.log(
      chalk.dim(
        `  Skipped (< ${report.minAgeHours}h old): ${report.totalSkippedRecent.toLocaleString()} files` +
        `  ·  use --min-age-hours 0 to include all`,
      ),
    );
  }
  console.log(chalk.dim(`  Scanned in ${report.durationMs} ms`));
  console.log('');

  printTopFiles(report);
}

function printCleanReport(report: CleanReport): void {
  const actionLabel = report.dryRun ? 'DRY-RUN' : 'CLEANED';
  const totalLabel  = report.dryRun ? 'Would free' : 'Freed';

  // Collect all failed files across targets
  const allFailed = report.results.flatMap(r => r.failedFiles);

  // For file-system targets only: attempted = deleted + failed (excludes external targets)
  const fsResults  = report.results.filter(r => !r.isExternal);
  const attempted  = fsResults.reduce((a, r) => a + r.deletedCount + r.failedFiles.length, 0);
  const successRate = attempted > 0
    ? ((report.totalDeletedFiles / attempted) * 100).toFixed(1)
    : '100.0';
  const failRate = attempted > 0
    ? ((report.totalFailed / attempted) * 100).toFixed(1)
    : '0.0';

  console.log('');
  console.log(chalk.bold(report.dryRun ? 'Dry Run Results' : 'Clean Results'));
  console.log(chalk.dim(DIVIDER));

  for (const r of report.results) {
    const statusColor = report.dryRun ? chalk.blue : chalk.green;
    const badge       = statusColor(`[${actionLabel}]`).padEnd(20);
    const size        = chalk.cyan(fmt(r.deletedBytes).padStart(10));
    console.log(`  ${badge} ${r.label.padEnd(22)} ${size}`);
  }

  console.log(chalk.dim(DIVIDER));
  console.log(`  ${totalLabel.padEnd(44)} ${chalk.bold.green(fmt(report.totalDeletedBytes).padStart(10))}`);
  console.log('');

  // Summary table
  console.log(chalk.bold('  Summary'));
  console.log(`    Eligible files    ${attempted.toLocaleString()}`);
  console.log(`    Deleted           ${chalk.green(report.totalDeletedFiles.toLocaleString())}`);
  if (report.totalSkippedRecent > 0) {
    console.log(`    Skipped (recent)  ${chalk.dim(report.totalSkippedRecent.toLocaleString())}`);
  }
  if (report.totalFailed > 0) {
    console.log(`    Failed            ${chalk.yellow(report.totalFailed.toLocaleString())}`);
  }
  console.log(`    Success rate      ${chalk.green(successRate + '%')}`);
  if (report.totalFailed > 0) {
    console.log(`    Failure rate      ${chalk.yellow(failRate + '%')}`);
  }

  // Failed files detail
  if (allFailed.length > 0) {
    console.log('');
    console.log(chalk.bold(`  Failed files (${allFailed.length}):`));
    for (const f of allFailed) {
      // Extract error code if present (e.g. "EBUSY: ..."), otherwise show full message
      const code = f.error.match(/^([A-Z_]+):/)?.[1] ?? f.error.slice(0, 40);
      console.log(`    ${chalk.yellow(code.padEnd(10))}  ${chalk.dim(truncatePath(f.path, 55))}`);
    }
  }

  console.log('');
  console.log(chalk.dim(`  Completed in ${report.durationMs} ms`));
  console.log('');
}

// ─── Commands ────────────────────────────────────────────────────────────────

const program = new Command();

program
  .name('pc-cleaner')
  .description('Windows disk cleaner — safe, transparent, always confirms before deleting')
  .version('1.0.0');

function parseTargets(raw: string | undefined): string[] {
  if (!raw) return DEFAULT_TARGET_KEYS;
  const keys = raw.split(',').map(k => k.trim()).filter(Boolean);
  // Validate early so the error is shown before scanning starts
  for (const key of keys) {
    if (!ALL_TARGETS[key]) {
      console.error(chalk.red(`Unknown target: "${key}". Available: ${Object.keys(ALL_TARGETS).join(', ')}`));
      process.exit(1);
    }
  }
  return keys;
}

program
  .command('scan')
  .description('Scan for unnecessary files and show a size report')
  .option('--targets <keys>', `Comma-separated targets to scan (default: ${DEFAULT_TARGET_KEYS.join(',')})`)
  .option('--min-age-hours <hours>', 'Minimum file age in hours to be eligible for deletion', '24')
  .action(async (opts: { targets?: string; minAgeHours: string }) => {
    const targetKeys  = parseTargets(opts.targets);
    const minAgeHours = Math.max(0, Number(opts.minAgeHours));
    const spinner = ora('Scanning…').start();
    try {
      const report = await runScan(minAgeHours, targetKeys);
      spinner.stop();
      printScanReport(report);
      if (report.totalEligibleBytes === 0) {
        console.log(chalk.green('No eligible files found.'));
      }
    } catch (err) {
      spinner.fail('Scan failed');
      console.error(chalk.red(String(err)));
      process.exit(1);
    }
  });

program
  .command('clean')
  .description('Scan and clean unnecessary files (asks for confirmation)')
  .option('--targets <keys>', `Comma-separated targets to clean (default: ${DEFAULT_TARGET_KEYS.join(',')})`)
  .option('--dry-run', 'Simulate deletion without actually removing files', false)
  .option('--min-age-hours <hours>', 'Minimum file age in hours to be eligible for deletion', '24')
  .action(async (opts: { targets?: string; dryRun: boolean; minAgeHours: string }) => {
    const targetKeys  = parseTargets(opts.targets);
    const minAgeHours = Math.max(0, Number(opts.minAgeHours));

    // Phase 1: Scan
    const scanSpinner = ora('Scanning…').start();
    let scanReport: ScanReport;
    try {
      scanReport = await runScan(minAgeHours, targetKeys);
      scanSpinner.stop();
    } catch (err) {
      scanSpinner.fail('Scan failed');
      console.error(chalk.red(String(err)));
      process.exit(1);
    }

    printScanReport(scanReport);

    if (scanReport.totalEligibleBytes === 0) {
      console.log(chalk.green('No eligible files to clean.'));
      return;
    }

    // Phase 2: Confirm (skip in dry-run)
    if (!opts.dryRun) {
      const proceed = await confirm({
        message: `Delete ${fmt(scanReport.totalEligibleBytes)} of temporary files (${scanReport.totalEligibleFiles.toLocaleString()} files)?`,
        default: false,
      });
      if (!proceed) {
        console.log(chalk.dim('Cancelled.'));
        return;
      }
    }

    // Phase 3: Clean
    const cleanSpinner = ora(opts.dryRun ? 'Simulating…' : 'Cleaning…').start();
    let cleanReport: CleanReport;
    try {
      cleanReport = await runClean(scanReport, opts.dryRun, targetKeys);
      cleanSpinner.stop();
    } catch (err) {
      cleanSpinner.fail('Clean failed');
      console.error(chalk.red(String(err)));
      process.exit(1);
    }

    printCleanReport(cleanReport);
  });

program.parse(process.argv);
