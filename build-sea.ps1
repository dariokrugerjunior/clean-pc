Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Write-Host "1/5 Bundling CJS para SEA..." -ForegroundColor Cyan
npm run build:sea-bundle

Write-Host "2/5 Gerando blob SEA..." -ForegroundColor Cyan
node --experimental-sea-config sea-config.json

Write-Host "3/5 Copiando node.exe..." -ForegroundColor Cyan
$nodePath = (Get-Command node -ErrorAction Stop).Source
Copy-Item $nodePath clean-pc.exe -Force

Write-Host "4/5 Removendo assinatura digital..." -ForegroundColor Cyan
$signtoolPaths = @(
  "C:\Program Files (x86)\Windows Kits\10\bin\x64\signtool.exe",
  "C:\Program Files (x86)\Windows Kits\10\bin\10.0.22621.0\x64\signtool.exe",
  "C:\Program Files (x86)\Windows Kits\10\bin\10.0.26100.0\x64\signtool.exe"
)
$signtool = $signtoolPaths | Where-Object { Test-Path $_ } | Select-Object -First 1
if ($signtool) {
  & $signtool remove /s clean-pc.exe 2>$null
  Write-Host "   signtool OK" -ForegroundColor Green
} else {
  Write-Warning "signtool.exe nao encontrado -- continuando sem remover assinatura (funciona para uso pessoal/desenvolvimento)"
}

Write-Host "5/5 Injetando blob no executavel..." -ForegroundColor Cyan
npx postject clean-pc.exe NODE_SEA_BLOB sea-prep.blob `
  --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 `
  --overwrite

Write-Host ""
Write-Host "clean-pc.exe gerado com sucesso!" -ForegroundColor Green
$sizeMB = [math]::Round((Get-Item clean-pc.exe).Length / 1MB, 1)
Write-Host "Tamanho: $sizeMB MB"
Write-Host ""
Write-Host "Para usar em qualquer terminal, mova o executavel para um diretorio no PATH:" -ForegroundColor Yellow
Write-Host "  Move-Item clean-pc.exe `"`$env:USERPROFILE\bin\clean-pc.exe`" -Force"
