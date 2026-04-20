[CmdletBinding()]
param(
  [string[]]$Arch = @('x64')
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

$artifacts = @{
  x64 = 'clean-pc-win-x64.exe'
  x86 = 'clean-pc-win-x86.exe'
}

$nodeVersionFile = Join-Path $root '.node-version'
$nodeVersion = (Get-Content $nodeVersionFile -Raw).Trim()
if (-not $nodeVersion) {
  throw "Arquivo .node-version vazio."
}

$distBaseUrl = "https://nodejs.org/dist/$nodeVersion"
$cacheDir = Join-Path $root '.sea-cache'
$nodeCacheDir = Join-Path $cacheDir "node-$nodeVersion"
$checksumsPath = Join-Path $nodeCacheDir 'SHASUMS256.txt'
$baseSeaConfig = Get-Content (Join-Path $root 'sea-config.json') -Raw | ConvertFrom-Json
$signtoolPaths = @(
  "C:\Program Files (x86)\Windows Kits\10\bin\x64\signtool.exe",
  "C:\Program Files (x86)\Windows Kits\10\bin\10.0.22621.0\x64\signtool.exe",
  "C:\Program Files (x86)\Windows Kits\10\bin\10.0.26100.0\x64\signtool.exe"
)
$signtool = $signtoolPaths | Where-Object { Test-Path $_ } | Select-Object -First 1

function Assert-LastExitCode([string]$CommandName) {
  if ($LASTEXITCODE -ne 0) {
    throw "$CommandName falhou com exit code $LASTEXITCODE."
  }
}

function Ensure-Directory([string]$Path) {
  if (-not (Test-Path $Path)) {
    New-Item -ItemType Directory -Path $Path | Out-Null
  }
}

function Ensure-File([string]$Url, [string]$Destination) {
  if (Test-Path $Destination) {
    return
  }

  Ensure-Directory (Split-Path -Parent $Destination)
  Invoke-WebRequest -Uri $Url -OutFile $Destination
}

function Get-ExpectedHash([string]$ArchName) {
  $relativePath = "win-$ArchName/node.exe"
  $entry = Select-String -Path $checksumsPath -Pattern ([regex]::Escape($relativePath)) |
    Select-Object -First 1

  if (-not $entry) {
    throw "Checksum de $relativePath nao encontrado em SHASUMS256.txt."
  }

  return ($entry.Line -split '\s+')[0].ToLowerInvariant()
}

function Get-Sha256([string]$Path) {
  $stream = [System.IO.File]::OpenRead($Path)
  try {
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    try {
      $hashBytes = $sha256.ComputeHash($stream)
    } finally {
      $sha256.Dispose()
    }
  } finally {
    $stream.Dispose()
  }

  return ([System.BitConverter]::ToString($hashBytes)).Replace('-', '').ToLowerInvariant()
}

function Ensure-VerifiedNodeBinary([string]$ArchName) {
  $nodeDir = Join-Path $nodeCacheDir "win-$ArchName"
  $nodeExe = Join-Path $nodeDir 'node.exe'

  Ensure-File "$distBaseUrl/SHASUMS256.txt" $checksumsPath
  Ensure-File "$distBaseUrl/win-$ArchName/node.exe" $nodeExe

  $actualHash = Get-Sha256 $nodeExe
  $expectedHash = Get-ExpectedHash $ArchName
  if ($actualHash -ne $expectedHash) {
    throw "Checksum invalido para win-$ArchName/node.exe. Esperado: $expectedHash. Obtido: $actualHash."
  }

  return $nodeExe
}

function New-SeaConfig([string]$ArchName) {
  $configPath = Join-Path $cacheDir "sea-config-$ArchName.json"
  $blobPath = Join-Path $root "sea-prep-$ArchName.blob"

  $config = [ordered]@{
    main = $baseSeaConfig.main
    output = $blobPath
    disableExperimentalSEAWarning = [bool]$baseSeaConfig.disableExperimentalSEAWarning
  }

  if ($baseSeaConfig.PSObject.Properties.Name -contains 'useSnapshot') {
    $config.useSnapshot = [bool]$baseSeaConfig.useSnapshot
  }
  if ($baseSeaConfig.PSObject.Properties.Name -contains 'useCodeCache') {
    $config.useCodeCache = [bool]$baseSeaConfig.useCodeCache
  }
  if ($baseSeaConfig.PSObject.Properties.Name -contains 'assets') {
    $config.assets = $baseSeaConfig.assets
  }
  if ($baseSeaConfig.PSObject.Properties.Name -contains 'execArgv') {
    $config.execArgv = $baseSeaConfig.execArgv
  }
  if ($baseSeaConfig.PSObject.Properties.Name -contains 'execArgvExtension') {
    $config.execArgvExtension = $baseSeaConfig.execArgvExtension
  }

  $json = $config | ConvertTo-Json -Depth 10
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($configPath, $json, $utf8NoBom)

  return @{
    ConfigPath = $configPath
    BlobPath = $blobPath
  }
}

Ensure-Directory $cacheDir
Ensure-Directory $nodeCacheDir

Write-Host "1/4 Bundling CJS para SEA..." -ForegroundColor Cyan
npm run build:sea-bundle
Assert-LastExitCode 'npm run build:sea-bundle'

$targets = @(
  @(
    $Arch |
      ForEach-Object { $_ -split ',' } |
      ForEach-Object { $_.Trim().ToLowerInvariant() } |
      Where-Object { $_ }
  ) | Select-Object -Unique
)

if (-not $targets) {
  throw "Nenhuma arquitetura informada. Use x64, x86 ou ambas."
}

$invalidTargets = $targets | Where-Object { $_ -notin @('x64', 'x86') }
if ($invalidTargets) {
  throw "Arquiteturas invalidas: $($invalidTargets -join ', '). Use apenas x64 e x86."
}

$stepIndex = 2
$totalSteps = $targets.Count + 2

foreach ($archName in $targets) {
  $outputFile = Join-Path $root $artifacts[$archName]

  Write-Host "$stepIndex/$totalSteps Empacotando $archName..." -ForegroundColor Cyan

  $nodeExe = Ensure-VerifiedNodeBinary $archName
  $seaConfig = New-SeaConfig $archName

  & $nodeExe --experimental-sea-config $seaConfig.ConfigPath
  Assert-LastExitCode "node --experimental-sea-config ($archName)"

  Copy-Item $nodeExe $outputFile -Force

  if ($signtool) {
    & $signtool remove /s $outputFile 2>$null
    Write-Host "   signtool OK ($archName)" -ForegroundColor Green
  } else {
    Write-Warning "signtool.exe nao encontrado -- continuando sem remover assinatura ($archName)"
  }

  npx postject $outputFile NODE_SEA_BLOB $seaConfig.BlobPath `
    --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 `
    --overwrite
  Assert-LastExitCode "npx postject ($archName)"

  $sizeMB = [math]::Round((Get-Item $outputFile).Length / 1MB, 1)
  Write-Host "   $($artifacts[$archName]) gerado com sucesso ($sizeMB MB)" -ForegroundColor Green

  $stepIndex += 1
}

Write-Host "$stepIndex/$totalSteps Finalizado." -ForegroundColor Cyan
Write-Host ""
Write-Host "Artefatos gerados:" -ForegroundColor Yellow
foreach ($archName in $targets) {
  Write-Host "  - $($artifacts[$archName])"
}
