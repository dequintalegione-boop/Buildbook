$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$envFile = Join-Path $root '.env'
if (-not (Test-Path $envFile)) {
  Copy-Item (Join-Path $root '.env.example') $envFile
  Write-Host 'Создан .env из .env.example. Заполните секреты и абсолютные пути, затем запустите скрипт ещё раз.'
  exit 1
}

node --env-file="$envFile" .\host\run-buildbook-local-host.mjs
exit $LASTEXITCODE
