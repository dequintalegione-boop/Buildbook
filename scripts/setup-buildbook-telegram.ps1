$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$root = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $root '.env'
$dataDir = Join-Path $env:LOCALAPPDATA 'Buildbook\data'

Write-Host ''
Write-Host 'Buildbook — первичная настройка Telegram'
Write-Host 'Токен бота и ваш Telegram ID будут сохранены только в локальном .env.'
Write-Host 'Polling останется выключенным: включайте его только после проверки канонического профиля.'
Write-Host ''

if (-not (Test-Path -LiteralPath (Join-Path $root '.env.example'))) {
  throw 'Не найден .env.example. Запустите мастер из папки репозитория Buildbook.'
}

$pathInput = Read-Host "Папка данных [$dataDir]"
if (-not [string]::IsNullOrWhiteSpace($pathInput)) { $dataDir = $pathInput.Trim() }
if (-not [System.IO.Path]::IsPathRooted($dataDir)) {
  throw 'Укажите абсолютный путь к папке данных.'
}
$dataDir = [System.IO.Path]::GetFullPath($dataDir)

$userId = (Read-Host 'Ваш числовой Telegram user ID (не username)').Trim()
if ($userId -notmatch '^[1-9]\d{0,15}$') {
  throw 'Telegram user ID должен быть положительным числом до 16 цифр.'
}

$secureToken = Read-Host 'Токен бота от BotFather' -AsSecureString
$tokenPtr = [IntPtr]::Zero
$botToken = $null
try {
  $tokenPtr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureToken)
  $botToken = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($tokenPtr)
  if ($botToken -notmatch '^[1-9]\d{0,15}:[A-Za-z0-9_-]{20,}$' -or $botToken.Length -gt 256) {
    throw 'Формат токена не похож на токен Telegram Bot API.'
  }

  $apiBytes = New-Object byte[] 32
  $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($apiBytes) } finally { $rng.Dispose() }
  $apiToken = ([BitConverter]::ToString($apiBytes)).Replace('-', '').ToLowerInvariant()
  [Array]::Clear($apiBytes, 0, $apiBytes.Length)

  New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
  $values = [ordered]@{
    'BUILDBOOK_PROFILE_PATH' = Join-Path $dataDir 'profile.json'
    'BUILDBOOK_PROFILE_LOCK_PATH' = Join-Path $dataDir 'profile.lock'
    'BUILDBOOK_LOCAL_API_HOST' = '127.0.0.1'
    'BUILDBOOK_LOCAL_API_PORT' = '43127'
    'BUILDBOOK_LOCAL_API_TOKEN' = $apiToken
    'BUILDBOOK_TELEGRAM_ENABLED' = 'false'
    'BUILDBOOK_TELEGRAM_BOT_TOKEN' = $botToken
    'BUILDBOOK_TELEGRAM_ALLOWED_USER_IDS' = $userId
    'BUILDBOOK_TELEGRAM_INBOX_PATH' = Join-Path $dataDir 'telegram-inbox.json'
    'BUILDBOOK_TELEGRAM_OFFSET_PATH' = Join-Path $dataDir 'telegram-offset.json'
    'BUILDBOOK_TELEGRAM_INSTANCE_LOCK_PATH' = Join-Path $dataDir 'telegram.lock'
  }

  $lines = @()
  $backup = $null
  if (Test-Path -LiteralPath $envFile) {
    $lines = @(Get-Content -LiteralPath $envFile)
    $backupId = [guid]::NewGuid().ToString('N')
    $backup = "$envFile.backup-$(Get-Date -Format 'yyyyMMdd-HHmmss')-$backupId"
    Copy-Item -LiteralPath $envFile -Destination $backup
    Write-Host "Старая конфигурация сохранена в: $backup"
  } else {
    $lines = @(Get-Content -LiteralPath (Join-Path $root '.env.example'))
  }

  $written = @{}
  $output = foreach ($line in $lines) {
    if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)=') {
      $key = $Matches[1]
      if ($values.Contains($key)) {
        if (-not $written.ContainsKey($key)) {
          $written[$key] = $true
          "$key=$($values[$key])"
        }
        continue
      }
    }
    $line
  }
  foreach ($key in $values.Keys) {
    if (-not $written.ContainsKey($key)) { $output += "$key=$($values[$key])" }
  }

  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllLines($envFile, [string[]]$output, $utf8NoBom)

  $aclTargets = @($envFile)
  if ($backup) { $aclTargets += $backup }
  try {
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
    foreach ($target in $aclTargets) {
      & icacls.exe $target /inheritance:r /grant:r "$($identity):(F)" | Out-Null
      if ($LASTEXITCODE -ne 0) {
        Write-Warning "Не удалось ограничить ACL для файла: $target. Проверьте права доступа вручную."
      }
    }
  } catch {
    Write-Warning 'Не удалось проверить ACL автоматически. Убедитесь, что .env и его резервная копия доступны только вашей учётной записи.'
  }

  Write-Host ''
  Write-Host 'Настройка сохранена. Токен не выводится на экран.'
  Write-Host "Файл: $envFile"
  Write-Host "Данные: $dataDir"
  Write-Host 'Telegram polling оставлен выключенным (BUILDBOOK_TELEGRAM_ENABLED=false).'
  Write-Host 'Следующий шаг: запустите scripts\start-buildbook-local-host.ps1, подключите вкладку Telegram и проверьте профиль.'
  Write-Host 'Не включайте polling до подтверждения, что интерфейс использует тот же канонический файловый профиль.'
} finally {
  if ($tokenPtr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($tokenPtr) }
  if ($botToken) { $botToken = $null }
  if ($secureToken) { $secureToken.Dispose() }
}
