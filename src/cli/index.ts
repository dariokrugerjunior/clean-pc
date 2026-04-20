import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { confirm, select, Separator } from '@inquirer/prompts';
import bytes from 'bytes';
import packageJson from '../../package.json' with { type: 'json' };
import { runScan, runClean } from '../orchestrator.js';
import type { ScanReport, CleanReport } from '../orchestrator.js';
import { DEFAULT_TARGET_KEYS, ALL_TARGETS } from '../targets.js';

// ─── Constantes ───────────────────────────────────────────────────────────────

const DIVISOR = '─'.repeat(60);
const TODOS_TARGETS = ['userTemp', 'windowsTemp', 'recycleBin', 'npm', 'logs'];

// ─── Formatação ───────────────────────────────────────────────────────────────

function fmt(n: number): string {
  return bytes(n, { unitSeparator: ' ', decimalPlaces: 2 }) ?? '0 B';
}

const TOP_N = 10;

function truncarCaminho(p: string, maxLen = 60): string {
  if (p.length <= maxLen) return p;
  const half = Math.floor((maxLen - 3) / 2);
  return `${p.slice(0, half)}...${p.slice(-half)}`;
}

function traduzirRisco(riskLevel: string): string {
  switch (riskLevel) {
    case 'safe':       return 'SEGURO';
    case 'moderate':   return 'MODERADO';
    case 'aggressive': return 'AGRESSIVO';
    default:           return riskLevel.toUpperCase();
  }
}

function corRisco(riskLevel: string): (text: string) => string {
  switch (riskLevel) {
    case 'safe':       return chalk.green;
    case 'moderate':   return chalk.yellow;
    case 'aggressive': return chalk.red;
    default:           return chalk.white;
  }
}

// ─── Relatórios ───────────────────────────────────────────────────────────────

function imprimirTopArquivos(report: ScanReport): void {
  const elegíveis = report.results.flatMap(r => r.isExternal ? [] : r.files.filter(f => !f.tooRecent));
  const recentes  = report.results.flatMap(r => r.isExternal ? [] : r.files.filter(f => f.tooRecent));

  if (elegíveis.length === 0 && recentes.length === 0) return;

  if (elegíveis.length > 0) {
    const porTamanho = [...elegíveis].sort((a, b) => b.sizeBytes - a.sizeBytes).slice(0, TOP_N);
    console.log(chalk.bold(`  Top ${TOP_N} maiores arquivos elegíveis:`));
    for (const f of porTamanho) {
      const tamanho = chalk.cyan(fmt(f.sizeBytes).padStart(10));
      const caminho = chalk.dim(truncarCaminho(f.path));
      console.log(`    ${tamanho}  ${caminho}`);
    }
    console.log('');
  }

  const todoArquivos = [...elegíveis, ...recentes];
  const porData = [...todoArquivos].sort((a, b) => b.modifiedAt.getTime() - a.modifiedAt.getTime()).slice(0, TOP_N);
  console.log(chalk.bold(`  Top ${TOP_N} modificados recentemente:`));
  for (const f of porData) {
    const data   = chalk.yellow(f.modifiedAt.toLocaleString('pt-BR').padEnd(22));
    const aviso  = f.tooRecent ? chalk.red(' [muito recente, ignorado]') : '';
    const caminho = chalk.dim(truncarCaminho(f.path));
    console.log(`    ${data}  ${caminho}${aviso}`);
  }
  console.log('');
}

function imprimirRelatorioScan(report: ScanReport): void {
  console.log('');
  console.log(chalk.bold('Resultado da Análise'));
  console.log(chalk.dim(DIVISOR));

  for (const r of report.results) {
    const badge = corRisco(r.riskLevel)(`[${traduzirRisco(r.riskLevel)}]`).padEnd(20);
    const size  = chalk.cyan(fmt(r.totalBytes).padStart(10));
    const aviso = r.error ? chalk.yellow(`  ⚠ ${r.error}`) : '';

    if (r.isExternal) {
      const nota = r.eligibleBytes > 0 ? chalk.dim('(estimado via sistema)') : chalk.dim('(vazio)');
      console.log(`  ${badge} ${r.label.padEnd(22)} ${size}  ${nota}${aviso}`);
    } else {
      const contagem = chalk.dim(`(${r.fileCount.toLocaleString('pt-BR')} arquivos encontrados)`);
      console.log(`  ${badge} ${r.label.padEnd(22)} ${size}  ${contagem}${aviso}`);
      console.log(
        chalk.dim(
          `    elegíveis: ${r.eligibleCount.toLocaleString('pt-BR')} arquivos (${fmt(r.eligibleBytes)})` +
          (r.skippedRecentCount > 0
            ? `  ·  ignorados (muito recentes): ${r.skippedRecentCount.toLocaleString('pt-BR')}`
            : ''),
        ),
      );
    }
  }

  console.log(chalk.dim(DIVISOR));
  console.log(
    `  ${'Espaço que pode ser liberado'.padEnd(44)} ${chalk.bold.cyan(fmt(report.totalEligibleBytes).padStart(10))}`,
  );
  if (report.totalSkippedRecent > 0) {
    console.log(
      chalk.dim(
        `  Ignorados (< ${report.minAgeHours}h): ${report.totalSkippedRecent.toLocaleString('pt-BR')} arquivos` +
        `  ·  use --min-age-hours 0 para incluir todos`,
      ),
    );
  }
  console.log(chalk.dim(`  Análise concluída em ${report.durationMs} ms`));
  console.log('');

  imprimirTopArquivos(report);
}

function imprimirRelatorioLimpeza(report: CleanReport): void {
  const labelAção   = report.dryRun ? 'SIMULAÇÃO' : 'LIMPO';
  const labelTotal  = report.dryRun ? 'Seria liberado' : 'Liberado';

  const todosFalhos = report.results.flatMap(r => r.failedFiles);

  const fsResults   = report.results.filter(r => !r.isExternal);
  const tentados    = fsResults.reduce((a, r) => a + r.deletedCount + r.failedFiles.length, 0);
  const taxaSucesso = tentados > 0
    ? ((report.totalDeletedFiles / tentados) * 100).toFixed(1)
    : '100.0';
  const taxaFalha = tentados > 0
    ? ((report.totalFailed / tentados) * 100).toFixed(1)
    : '0.0';

  console.log('');
  console.log(chalk.bold(report.dryRun ? 'Resultado da Simulação' : 'Resultado da Limpeza'));
  console.log(chalk.dim(DIVISOR));

  for (const r of report.results) {
    const corStatus = report.dryRun ? chalk.blue : chalk.green;
    const badge     = corStatus(`[${labelAção}]`).padEnd(20);
    const size      = chalk.cyan(fmt(r.deletedBytes).padStart(10));
    console.log(`  ${badge} ${r.label.padEnd(22)} ${size}`);
  }

  console.log(chalk.dim(DIVISOR));
  console.log(`  ${labelTotal.padEnd(44)} ${chalk.bold.green(fmt(report.totalDeletedBytes).padStart(10))}`);
  console.log('');

  console.log(chalk.bold('  Resumo'));
  console.log(`    Arquivos elegíveis   ${tentados.toLocaleString('pt-BR')}`);
  console.log(`    Deletados            ${chalk.green(report.totalDeletedFiles.toLocaleString('pt-BR'))}`);
  if (report.totalSkippedRecent > 0) {
    console.log(`    Ignorados (recentes) ${chalk.dim(report.totalSkippedRecent.toLocaleString('pt-BR'))}`);
  }
  if (report.totalFailed > 0) {
    console.log(`    Falhas               ${chalk.yellow(report.totalFailed.toLocaleString('pt-BR'))}`);
  }
  console.log(`    Taxa de sucesso      ${chalk.green(taxaSucesso + '%')}`);
  if (report.totalFailed > 0) {
    console.log(`    Taxa de falha        ${chalk.yellow(taxaFalha + '%')}`);
  }

  if (todosFalhos.length > 0) {
    console.log('');
    console.log(chalk.bold(`  Arquivos com falha (${todosFalhos.length}):`));
    for (const f of todosFalhos) {
      const code = f.error.match(/^([A-Z_]+):/)?.[1] ?? f.error.slice(0, 40);
      console.log(`    ${chalk.yellow(code.padEnd(10))}  ${chalk.dim(truncarCaminho(f.path, 55))}`);
    }
  }

  console.log('');
  console.log(chalk.dim(`  Concluído em ${report.durationMs} ms`));
  console.log('');
}

// ─── Fluxos reutilizáveis ─────────────────────────────────────────────────────

async function fluxoScan(targetKeys: string[], minAgeHours = 24): Promise<ScanReport | null> {
  const spinner = ora('Analisando…').start();
  try {
    const report = await runScan(minAgeHours, targetKeys);
    spinner.stop();
    imprimirRelatorioScan(report);
    if (report.totalEligibleBytes === 0) {
      console.log(chalk.green('Nenhum arquivo elegível encontrado.'));
    }
    return report;
  } catch (err) {
    spinner.fail('Falha na análise');
    console.error(chalk.red(String(err)));
    return null;
  }
}

async function fluxoLimpeza(
  targetKeys: string[],
  dryRun: boolean,
  minAgeHours = 24,
): Promise<void> {
  const scanReport = await fluxoScan(targetKeys, minAgeHours);
  if (!scanReport) return;

  if (scanReport.totalEligibleBytes === 0) {
    console.log(chalk.green('Nada a limpar.'));
    return;
  }

  if (!dryRun) {
    const confirmar = await confirm({
      message: `Deletar ${fmt(scanReport.totalEligibleBytes)} de arquivos temporários (${scanReport.totalEligibleFiles.toLocaleString('pt-BR')} arquivos)?`,
      default: false,
    });
    if (!confirmar) {    console.log(chalk.dim('Opera\u00e7\u00e3o cancelada.'));
      return;
    }
  }

  const cleanSpinner = ora(dryRun ? 'Simulando…' : 'Limpando…').start();
  try {
    const cleanReport = await runClean(scanReport, dryRun, targetKeys);
    cleanSpinner.stop();
    imprimirRelatorioLimpeza(cleanReport);
  } catch (err) {
    cleanSpinner.fail('Falha na limpeza');
    console.error(chalk.red(String(err)));
  }
}

// ─── Menu interativo ──────────────────────────────────────────────────────────

const OPCOES_MENU = [
  {
    name: '🔍  Analisar espaço que pode ser liberado',
    value: 'scan-all',
  },
  new Separator('─── Limpeza por categoria ───'),
  {
    name: '🗂️   Temporários do usuário',
    value: 'clean-userTemp',
  },
  {
    name: '🪟  Temporários do Windows',
    value: 'clean-windowsTemp',
  },
  {
    name: '🗑️   Esvaziar lixeira',
    value: 'clean-recycleBin',
  },
  {
    name: '📦  Limpar cache do npm',
    value: 'clean-npm',
  },
  {
    name: '📋  Limpar logs',
    value: 'clean-logs',
  },
  new Separator('─── Limpeza completa ───'),
  {
    name: '✨  Limpeza segura completa',
    value: 'clean-all',
  },
  new Separator(),
  {
    name: '❌  Sair',
    value: 'sair',
  },
] as const;

const BANNER_LINES = [
  '  ____ _     _____    _    _   _      ____   ____ ',
  ' / ___| |   | ____|  / \\\\  | \\\\ | |    |  _ \\\\ / ___|',
  '| |   | |   |  _|   / _ \\\\ |  \\\\| |____| |_) | |',
  '| |___| |___| |___ / ___ \\\\| |\\\\  |____|  __/| |___',
  ' \\\\____|_____|_____/_/   \\\\_\\\\_| \\\\_|    |_|    \\\\____|',
] as const;
const MENU_SEPARATOR = '------------------------------';
const MENU_CHOICES = [
  {
    name: 'Analisar espa\u00e7o que pode ser liberado',
    value: 'scan-all',
  },
  new Separator(`${MENU_SEPARATOR} Limpeza por categoria ${MENU_SEPARATOR}`),
  {
    name: 'Limpar tempor\u00e1rios do usu\u00e1rio',
    value: 'clean-userTemp',
  },
  {
    name: 'Limpar tempor\u00e1rios do Windows',
    value: 'clean-windowsTemp',
  },
  {
    name: 'Esvaziar lixeira',
    value: 'clean-recycleBin',
  },
  {
    name: 'Limpar cache do npm',
    value: 'clean-npm',
  },
  {
    name: 'Limpar logs',
    value: 'clean-logs',
  },
  new Separator(MENU_SEPARATOR.repeat(2)),
  {
    name: 'Limpeza segura completa',
    value: 'clean-all',
  },
  new Separator(MENU_SEPARATOR.repeat(2)),
  {
    name: 'Sair',
    value: 'sair',
  },
] as const;

function renderBanner(): void {
  console.log('');
  console.log(chalk.cyanBright(BANNER_LINES.join('\n')));
  console.log(chalk.white('  Limpador de disco para Windows'));
  console.log(chalk.dim(`  v${packageJson.version}`));
  console.log('');
}

type OpcaoMenu = (typeof MENU_CHOICES[number] extends { value: infer V } ? V : never);

async function modoInterativo(showBanner = true): Promise<void> {
  if (showBanner) {
    renderBanner();
  } else {
    console.log('');
  }

  while (true) {
    const opcao = await select<OpcaoMenu>({
      message: 'O que deseja fazer?',
      choices: MENU_CHOICES as any,
      pageSize: 11,
    });

    console.log('');

    switch (opcao) {
      case 'scan-all':
        await fluxoScan(TODOS_TARGETS);
        break;

      case 'clean-userTemp':
        await fluxoLimpeza(['userTemp'], false);
        break;

      case 'clean-windowsTemp':
        await fluxoLimpeza(['windowsTemp'], false);
        break;

      case 'clean-recycleBin':
        await fluxoLimpeza(['recycleBin'], false);
        break;

      case 'clean-npm':
        await fluxoLimpeza(['npm'], false);
        break;

      case 'clean-logs':
        await fluxoLimpeza(['logs'], false);
        break;

      case 'clean-all':
        await fluxoLimpeza(TODOS_TARGETS, false);
        break;

      case 'sair':
        console.log(chalk.dim('At\u00e9 logo!'));
        process.exit(0);
    }

    console.log('');
  }
}

// ─── Helpers CLI ──────────────────────────────────────────────────────────────

function parsearTargets(raw: string | undefined): string[] {
  if (!raw) return DEFAULT_TARGET_KEYS;
  const keys = raw.split(',').map(k => k.trim()).filter(Boolean);
  for (const key of keys) {
    if (!ALL_TARGETS[key]) {
      console.error(chalk.red(`Target desconhecido: "${key}". Disponíveis: ${Object.keys(ALL_TARGETS).join(', ')}`));
      process.exit(1);
    }
  }
  return keys;
}

function isPromptInterrupt(err: unknown): boolean {
  return err instanceof Error &&
    err.name === 'ExitPromptError' &&
    err.message.includes('SIGINT');
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

const program = new Command();

program
  .name('clean-pc')
  .description('Limpador de disco para Windows — seguro, transparente e sempre pede confirmação')
  .version(packageJson.version)
  .option('--no-banner', 'Oculta o banner no modo interativo')
  .action((opts: { banner: boolean }) => modoInterativo(opts.banner));

program
  .command('scan')
  .description('Analisa arquivos desnecessários e exibe um relatório de tamanho')
  .option('--targets <keys>', `Targets separados por vírgula (padrão: ${DEFAULT_TARGET_KEYS.join(',')})`)
  .option('--min-age-hours <hours>', 'Idade mínima em horas para o arquivo ser elegível', '24')
  .action(async (opts: { targets?: string; minAgeHours: string }) => {
    const targetKeys  = parsearTargets(opts.targets);
    const minAgeHours = Math.max(0, Number(opts.minAgeHours));
    await fluxoScan(targetKeys, minAgeHours);
  });

program
  .command('clean')
  .description('Analisa e limpa arquivos desnecessários (pede confirmação)')
  .option('--targets <keys>', `Targets separados por vírgula (padrão: ${DEFAULT_TARGET_KEYS.join(',')})`)
  .option('--dry-run', 'Simula a exclusão sem remover arquivos de verdade', false)
  .option('--min-age-hours <hours>', 'Idade mínima em horas para o arquivo ser elegível', '24')
  .action(async (opts: { targets?: string; dryRun: boolean; minAgeHours: string }) => {
    const targetKeys  = parsearTargets(opts.targets);
    const minAgeHours = Math.max(0, Number(opts.minAgeHours));
    await fluxoLimpeza(targetKeys, opts.dryRun, minAgeHours);
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  if (isPromptInterrupt(err)) {
    console.log('');
    console.log(chalk.dim('Opera\u00e7\u00e3o cancelada.'));
    process.exit(130);
  }

  throw err;
});
