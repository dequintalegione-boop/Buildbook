$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

Write-Host ''
Write-Host 'Buildbook — первоначальная настройка локального хоста и Telegram' -ForegroundColor Cyan
Write-Host 'Токен бота будет записан только в локальный .env и не выводится на экран.'
Write-Host ''

$token = Read-Host 'Введите токен бота от BotFather'
if ($token -notmatch '^(\d{1,16}):[A-Za-z0-9_-]{20,}$') {
  throw 'Формат токена не похож на токен Telegram Bot API. Проверьте ввод.'
}

$userId = Read-Host 'Введите ваш числовой Telegram user ID (не username)'
if ($userId -notmatch '^\d{1,16}$' -or [decimal]$userId -le 0) {
  throw 'Telegram user ID должен быть положительным числом.'
}

$envFile = Join-Path $root '.env'
if (Test-Path $envFile) {
  $backup = "$envFile.backup-$(Get-Date -Format yyyyMMdd-HHmmss)"
  Copy-Item -LiteralPath $envFile -Destination $backup
  Write-Host "Существующий .env сохранён в $backup" -ForegroundColor Yellow
}

$dataDir = Join-Path $root 'data'
New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
$randomBytes = New-Object byte[] 32
try { $rng.GetBytes($randomBytes) } finally { $rng.Dispose() }
$apiToken = -join ($randomBytes | ForEach-Object { $_.ToString('x2') })
$profile = Join-Path $dataDir 'profile.json'
$profileLock = Join-Path $dataDir 'profile.lock'
$inbox = Join-Path $dataDir 'telegram-inbox.json'
$offset = Join-Path $dataDir 'telegram-offset.json'
$instanceLock = Join-Path $dataDir 'telegram-service.lock'

$lines = @(
  "BUILDBOOK_PROFILE_PATH=$profile"
  "BUILDBOOK_PROFILE_LOCK_PATH=$profileLock"
  'BUILDBOOK_LOCAL_API_HOST=127.0.0.1'
  'BUILDBOOK_LOCAL_API_PORT=43127'
  "BUILDBOOK_LOCAL_API_TOKEN=$apiToken"
  'BUILDBOOK_TELEGRAM_ENABLED=false'
  "BUILDBOOK_TELEGRAM_BOT_TOKEN=$token"
  "BUILDBOOK_TELEGRAM_ALLOWED_USER_IDS=$userId"
  "BUILDBOOK_TELEGRAM_INBOX_PATH=$inbox"
  "BUILDBOOK_TELEGRAM_OFFSET_PATH=$offset"
  "BUILDBOOK_TELEGRAM_INSTANCE_LOCK_PATH=$instanceLock"
)
[System.IO.File]::WriteAllLines($envFile, $lines, [System.Text.UTF8Encoding]::new($false))

Write-Host ''
Write-Host 'Настройка сохранена. Telegram оставлен выключенным до подтверждения канонического профиля.' -ForegroundColor Green
Write-Host 'Сначала запустите локальный хост, подключите Buildbook и завершите перенос/проверку профиля.'
Write-Host 'После переключения Buildbook на канонический файловый профиль включите Telegram в .env и перезапустите хост.' -ForegroundColor Yellow
Write-Host 'В .env находятся секреты. Не отправляйте его другим людям и не добавляйте в Git.'
Write-Host ''
Read-Host 'Нажмите Enter для выхода' | Out-Null
