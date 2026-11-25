$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$nodeCommand = Get-Command node -CommandType Application -ErrorAction SilentlyContinue
if (-not $nodeCommand) {
  throw 'Node.js 22 LTS или новее не найден. Установите Node.js 22 LTS и убедитесь, что команда node доступна в PATH.'
}

$nodeVersion = & $nodeCommand.Source -p "process.versions.node"
$nodeExitCode = $LASTEXITCODE
if ($nodeExitCode -ne 0 -or $nodeVersion -notmatch '^v?(\d+)\.') {
  throw 'Не удалось определить версию Node.js. Проверьте установку Node.js и PATH.'
}
if ([int]$Matches[1] -lt 22) {
  throw "Для локального хоста требуется Node.js 22 LTS или новее. Обнаружена версия $nodeVersion."
}

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
