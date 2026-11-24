$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$envFile = Join-Path $root '.env'
if (-not (Test-Path $envFile)) {
  Copy-Item (Join-Path $root '.env.example') $envFile
  Write-Host 'Создан .env из .env.example. Заполните секреты и абсолютные пути, затем запустите скрипт ещё раз.'
  exit 1
}

$logDir = Join-Path $root 'data'
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
$logFile = Join-Path $logDir 'local-host.log'
if ((Test-Path $logFile) -and (Get-Item $logFile).Length -gt 5MB) {
  $previousLog = "$logFile.1"
  if (Test-Path $previousLog) { Remove-Item $previousLog -Force }
  Move-Item $logFile $previousLog -Force
}

& node --env-file="$envFile" .\host\run-buildbook-local-host.mjs 2>&1 | Tee-Object -FilePath $logFile -Append
$exitCode = $LASTEXITCODE
exit $exitCode
