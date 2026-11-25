$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$root = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $root '.env'

function Read-Env {
  if (-not (Test-Path -LiteralPath $envFile)) {
    throw 'Не найден .env. Сначала запустите setup-buildbook-telegram.bat.'
  }
  $map = @{}
  foreach ($line in Get-Content -LiteralPath $envFile) {
    if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$') {
      $map[$Matches[1]] = $Matches[2].Trim()
    }
  }
  return $map
}

function Write-EnvValue([string]$key, [string]$value) {
  if ($value -match '[\r\n]') { throw 'Значение содержит недопустимый перевод строки.' }
  $lines = @(Get-Content -LiteralPath $envFile)
  $result = New-Object System.Collections.Generic.List[string]
  $found = $false
  foreach ($line in $lines) {
    if ($line -match ('^\s*' + [regex]::Escape($key) + '=')) {
      if (-not $found) {
        $result.Add("$key=$value")
        $found = $true
      }
    } else {
      $result.Add($line)
    }
  }
  if (-not $found) { $result.Add("$key=$value") }

  $backupId = [guid]::NewGuid().ToString('N')
  $backup = "$envFile.backup-$(Get-Date -Format 'yyyyMMdd-HHmmss')-$backupId"
  Copy-Item -LiteralPath $envFile -Destination $backup
  $temp = "$envFile.tmp-$backupId"
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllLines($temp, $result.ToArray(), $utf8NoBom)
  Move-Item -LiteralPath $temp -Destination $envFile -Force

  try {
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
    foreach ($target in @($envFile, $backup)) {
      & icacls.exe $target /inheritance:r /grant:r "$($identity):(F)" | Out-Null
      if ($LASTEXITCODE -ne 0) { Write-Warning "Не удалось ограничить ACL: $target" }
    }
  } catch {
    Write-Warning 'Не удалось проверить ACL. Проверьте доступ к .env и резервной копии вручную.'
  }
  Write-Host "Изменение сохранено. Резервная копия: $backup"
}

function Show-Menu {
  $cfg = Read-Env
  $enabled = [string]$cfg['BUILDBOOK_TELEGRAM_ENABLED']
  $ids = [string]$cfg['BUILDBOOK_TELEGRAM_ALLOWED_USER_IDS']
  Write-Host ''
  Write-Host 'Buildbook — управление Telegram'
  Write-Host ('Polling: ' + $(if ($enabled -eq 'true') { 'ВКЛЮЧЁН' } else { 'выключен' }))
  Write-Host ('Разрешённые Telegram ID: ' + $(if ($ids) { $ids } else { 'не настроены' }))
  Write-Host 'Токен бота скрыт и не отображается.'
  Write-Host ''
  Write-Host '1 — Включить polling'
  Write-Host '2 — Выключить polling'
  Write-Host '3 — Добавить разрешённый Telegram ID'
  Write-Host '4 — Удалить разрешённый Telegram ID'
  Write-Host 'Q — Выход'
}

while ($true) {
  Show-Menu
  $choice = (Read-Host 'Выберите действие').Trim().ToUpperInvariant()
  if ($choice -eq 'Q') { break }

  $cfg = Read-Env
  switch ($choice) {
    '1' {
      Write-Warning 'Включайте только после переноса и проверки канонического файлового профиля.'
      $confirm = (Read-Host 'Подтвердите, что интерфейс и Telegram используют один профиль (введите YES)').Trim()
      if ($confirm -ceq 'YES') {
        Write-EnvValue 'BUILDBOOK_TELEGRAM_ENABLED' 'true'
        Write-Host 'Polling включён в конфигурации. Перезапустите локальный хост.'
      } else { Write-Host 'Отменено.' }
    }
    '2' {
      Write-EnvValue 'BUILDBOOK_TELEGRAM_ENABLED' 'false'
      Write-Host 'Polling выключен в конфигурации. Перезапустите локальный хост.'
    }
    '3' {
      $ids = @(([string]$cfg['BUILDBOOK_TELEGRAM_ALLOWED_USER_IDS']) -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
      if ($ids.Count -ge 100) { Write-Warning 'Достигнут лимит 100 разрешённых ID.'; continue }
      $newId = (Read-Host 'Числовой Telegram user ID').Trim()
      if ($newId -notmatch '^[1-9]\d{0,15}$') { Write-Warning 'ID должен быть положительным числом до 16 цифр.'; continue }
      if ($ids -contains $newId) { Write-Host 'Этот ID уже разрешён.'; continue }
      $ids += $newId
      Write-EnvValue 'BUILDBOOK_TELEGRAM_ALLOWED_USER_IDS' ($ids -join ',')
      Write-Host 'ID добавлен. Перезапустите локальный хост.'
    }
    '4' {
      $ids = @(([string]$cfg['BUILDBOOK_TELEGRAM_ALLOWED_USER_IDS']) -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
      if ($ids.Count -le 1) { Write-Warning 'Нельзя удалить последний ID: сервис требует хотя бы одного разрешённого пользователя.'; continue }
      $removeId = (Read-Host 'ID для удаления').Trim()
      if ($ids -notcontains $removeId) { Write-Host 'Такого ID нет в allowlist.'; continue }
      $ids = @($ids | Where-Object { $_ -ne $removeId })
      Write-EnvValue 'BUILDBOOK_TELEGRAM_ALLOWED_USER_IDS' ($ids -join ',')
      Write-Host 'ID удалён. Перезапустите локальный хост.'
    }
    default { Write-Host 'Неизвестная команда.' }
  }
}
