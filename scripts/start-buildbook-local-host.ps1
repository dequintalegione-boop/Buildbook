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
$dataDir = Join-Path $env:LOCALAPPDATA 'Buildbook\data'
if (-not (Test-Path $envFile)) {
  Copy-Item (Join-Path $root '.env.example') $envFile
  $token = & node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))"
  if (-not $token -or $token.Length -lt 32) {
    throw 'Не удалось сгенерировать BUILDBOOK_LOCAL_API_TOKEN.'
  }
  New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
  $content = Get-Content -LiteralPath $envFile -Raw
  $content = $content -replace 'BUILDBOOK_PROFILE_PATH=.*', ("BUILDBOOK_PROFILE_PATH=" + (Join-Path $dataDir 'profile.json'))
  $content = $content -replace 'BUILDBOOK_PROFILE_LOCK_PATH=.*', ("BUILDBOOK_PROFILE_LOCK_PATH=" + (Join-Path $dataDir 'profile.lock'))
  $content = $content -replace 'BUILDBOOK_LOCAL_API_TOKEN=.*', ("BUILDBOOK_LOCAL_API_TOKEN=" + $token)
  $content = $content -replace 'BUILDBOOK_TELEGRAM_INBOX_PATH=.*', ("BUILDBOOK_TELEGRAM_INBOX_PATH=" + (Join-Path $dataDir 'telegram-inbox.json'))
  $content = $content -replace 'BUILDBOOK_TELEGRAM_OFFSET_PATH=.*', ("BUILDBOOK_TELEGRAM_OFFSET_PATH=" + (Join-Path $dataDir 'telegram-offset.json'))
  $content = $content -replace 'BUILDBOOK_TELEGRAM_INSTANCE_LOCK_PATH=.*', ("BUILDBOOK_TELEGRAM_INSTANCE_LOCK_PATH=" + (Join-Path $dataDir 'telegram.lock'))
  Set-Content -LiteralPath $envFile -Value $content -Encoding utf8 -NoNewline
  Write-Host ''
  Write-Host 'Создан .env: сгенерирован ключ API и пути данных в' $dataDir
  Write-Host 'При открытии интерфейса по адресу локального хоста подключение PWA выполняется автоматически.'
  Write-Host 'Для ручного подключения к отдельному адресу ключ находится в .env (BUILDBOOK_LOCAL_API_TOKEN).'
  Write-Host 'Токен бота и user ID настройте позже кнопкой «Настроить бота» в интерфейсе.'
  Write-Host 'Запускаю локальный хост...'
  Write-Host ''
}

$taskName = 'Buildbook Local Host'
$existingTask = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if (-not $existingTask -and [Environment]::UserInteractive) {
  Write-Host ''
  $answer = Read-Host 'Установить автоматический запуск хоста при входе в Windows и восстановление после сбоя? (Д/н)'
  if ($answer -match '^(д|да|y|yes)New-Item -ItemType Directory -Path $logDir -Force | Out-Null
$logFile = Join-Path $logDir 'local-host.log'
if ((Test-Path $logFile) -and (Get-Item $logFile).Length -gt 5MB) {
  $previousLog = "$logFile.1"
  if (Test-Path $previousLog) { Remove-Item $previousLog -Force }
  Move-Item $logFile $previousLog -Force
}

& node --env-file="$envFile" .\host\run-buildbook-local-host.mjs 2>&1 | Tee-Object -FilePath $logFile -Append
$exitCode = $LASTEXITCODE
exit $exitCode
) {
    & (Join-Path $PSScriptRoot 'install-buildbook-autostart.ps1') -NoStart
    if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) { Write-Warning 'Не удалось установить автозапуск. Его можно включить позже во вкладке Telegram.' }
  }
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
