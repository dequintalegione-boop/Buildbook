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
  New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
  $content = Get-Content -LiteralPath $envFile -Raw
  $content = $content -replace 'BUILDBOOK_PROFILE_PATH=.*', ("BUILDBOOK_PROFILE_PATH=" + (Join-Path $dataDir 'profile.json'))
  $content = $content -replace 'BUILDBOOK_PROFILE_LOCK_PATH=.*', ("BUILDBOOK_PROFILE_LOCK_PATH=" + (Join-Path $dataDir 'profile.lock'))
  $content = $content -replace 'BUILDBOOK_TELEGRAM_INBOX_PATH=.*', ("BUILDBOOK_TELEGRAM_INBOX_PATH=" + (Join-Path $dataDir 'telegram-inbox.json'))
  $content = $content -replace 'BUILDBOOK_TELEGRAM_OFFSET_PATH=.*', ("BUILDBOOK_TELEGRAM_OFFSET_PATH=" + (Join-Path $dataDir 'telegram-offset.json'))
  $content = $content -replace 'BUILDBOOK_TELEGRAM_INSTANCE_LOCK_PATH=.*', ("BUILDBOOK_TELEGRAM_INSTANCE_LOCK_PATH=" + (Join-Path $dataDir 'telegram.lock'))
  Set-Content -LiteralPath $envFile -Value $content -Encoding utf8 -NoNewline
  Write-Host 'Создан локальный .env и настроена папка данных:' $dataDir
}

# A copied .env.example contains a public placeholder. Never use it as the
# local API secret: generate a fresh random key even when .env already exists.
$existingEnv = Get-Content -LiteralPath $envFile -Raw
$tokenMatch = [regex]::Match($existingEnv, '(?m)^BUILDBOOK_LOCAL_API_TOKEN=(.*)$')
$existingToken = if ($tokenMatch.Success) { $tokenMatch.Groups[1].Value.Trim() } else { '' }
if ($existingToken -match '^REPLACE_' -or $existingToken.Length -lt 32 -or $existingToken.Length -gt 4096) {
  $generatedToken = & $nodeCommand.Source -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))"
  if (-not $generatedToken -or $generatedToken.Length -lt 32) {
    throw 'Не удалось автоматически создать секрет локального API.'
  }
  if ($tokenMatch.Success) {
    $existingEnv = [regex]::Replace($existingEnv, '(?m)^BUILDBOOK_LOCAL_API_TOKEN=.*$', ("BUILDBOOK_LOCAL_API_TOKEN=" + $generatedToken))
  } else {
    $existingEnv = $existingEnv.TrimEnd() + [Environment]::NewLine + ("BUILDBOOK_LOCAL_API_TOKEN=" + $generatedToken) + [Environment]::NewLine
  }
  Set-Content -LiteralPath $envFile -Value $existingEnv -Encoding utf8 -NoNewline
  Write-Host 'Секрет локального API автоматически создан. Копировать его в приложение не нужно.'
}

# Keep the host API secret readable only by the current Windows account.
$identity = (& whoami.exe).Trim()
if (-not $identity -or $identity -match '[\r\n]') {
  throw 'Не удалось определить текущую учётную запись Windows для защиты файла .env.'
}
& icacls.exe $envFile '/reset' '/inheritance:r' '/grant:r' ($identity + ':(F)') | Out-Null
if ($LASTEXITCODE -ne 0) {
  throw 'Не удалось ограничить доступ к .env. Локальный хост не будет запущен с небезопасными правами на секреты.'
}

Write-Host 'При открытии Buildbook через локальный хост подключение PWA выполняется автоматически.'
Write-Host 'Токен Telegram и ваш user ID позже вводятся в мастере внутри приложения.'
Write-Host 'Запускаю локальный хост...'

$logDir = Join-Path $root 'data'
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
$logFile = Join-Path $logDir 'local-host.log'
if ((Test-Path $logFile) -and (Get-Item $logFile).Length -gt 5MB) {
  $previousLog = "$logFile.1"
  if (Test-Path $previousLog) { Remove-Item $previousLog -Force }
  Move-Item $logFile $previousLog -Force
}

& $nodeCommand.Source --env-file="$envFile" .\host\run-buildbook-local-host.mjs 2>&1 | Tee-Object -FilePath $logFile -Append
$exitCode = $LASTEXITCODE
exit $exitCode
