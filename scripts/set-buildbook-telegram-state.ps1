param(
  [ValidateSet('enable','disable')][string]$Mode
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $root '.env'
if (-not (Test-Path -LiteralPath $envFile)) {
  throw '.env не найден. Сначала запустите мастер настройки Telegram.'
}
$lines = [System.Collections.Generic.List[string]]::new()
foreach ($line in [System.IO.File]::ReadAllLines($envFile)) { $lines.Add($line) }
$index = -1
for ($i = 0; $i -lt $lines.Count; $i++) {
  if ($lines[$i] -match '^\s*BUILDBOOK_TELEGRAM_ENABLED\s*=') { $index = $i; break }
}
if ($index -lt 0) { $lines.Add('BUILDBOOK_TELEGRAM_ENABLED=false'); $index = $lines.Count - 1 }
if ($Mode -eq 'enable') {
  $required = @('BUILDBOOK_PROFILE_PATH','BUILDBOOK_LOCAL_API_TOKEN','BUILDBOOK_TELEGRAM_BOT_TOKEN','BUILDBOOK_TELEGRAM_ALLOWED_USER_IDS','BUILDBOOK_TELEGRAM_INBOX_PATH','BUILDBOOK_TELEGRAM_OFFSET_PATH','BUILDBOOK_TELEGRAM_INSTANCE_LOCK_PATH')
  $values = @{}
  foreach ($line in $lines) {
    if ($line -match '^\s*([A-Z0-9_]+)\s*=\s*(.*)$') { $values[$Matches[1]] = $Matches[2].Trim().Trim('"') }
  }
  foreach ($key in $required) {
    if (-not $values[$key] -or $values[$key] -match 'REPLACE_WITH|YOUR_ACCOUNT_ID') { throw "Не заполнен параметр $key. Сначала завершите мастер настройки." }
  }
  foreach ($key in @('BUILDBOOK_PROFILE_PATH','BUILDBOOK_TELEGRAM_INBOX_PATH','BUILDBOOK_TELEGRAM_OFFSET_PATH','BUILDBOOK_TELEGRAM_INSTANCE_LOCK_PATH')) {
    if (-not [System.IO.Path]::IsPathRooted($values[$key])) { throw "$key должен содержать абсолютный путь." }
  }
  Write-Host 'ВНИМАНИЕ: включайте Telegram только после переноса профиля в файловое хранилище, повторного чтения, проверки SHA-256 и подтверждения канонического профиля в Buildbook.' -ForegroundColor Yellow
  $answer = Read-Host 'Вы проверили, что интерфейс Buildbook использует именно BUILDBOOK_PROFILE_PATH из .env? Введите ENABLE для продолжения'
  if ($answer -cne 'ENABLE') { Write-Host 'Изменения отменены.'; exit 0 }
}
$taskName = 'Buildbook Local Host'
$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($task) { Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue }
$lines[$index] = 'BUILDBOOK_TELEGRAM_ENABLED=' + ($(if ($Mode -eq 'enable') { 'true' } else { 'false' }))
$backup = $envFile + '.bak-' + (Get-Date -Format 'yyyyMMdd-HHmmss')
Copy-Item -LiteralPath $envFile -Destination $backup
[System.IO.File]::WriteAllLines($envFile, $lines, [System.Text.UTF8Encoding]::new($false))
if ($task) {
  Start-ScheduledTask -TaskName $taskName
  if ($Mode -eq 'enable') { Write-Host 'Telegram включён в конфигурации. Локальный хост перезапущен.' -ForegroundColor Green }
  else { Write-Host 'Telegram выключен в конфигурации. Локальный хост перезапущен.' -ForegroundColor Green }
} else {
  Write-Host 'Настройка сохранена. Автозапуск не установлен: перезапустите локальный хост вручную.' -ForegroundColor Yellow
}
Write-Host "Резервная копия .env: $backup"
