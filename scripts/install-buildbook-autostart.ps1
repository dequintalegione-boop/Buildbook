param([switch]$NoStart)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $root '.env'
if (-not (Test-Path $envFile)) {
  Copy-Item (Join-Path $root '.env.example') $envFile
  throw 'Создан .env. Заполните его и повторно запустите установку автозапуска.'
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js не найден в PATH текущего пользователя.' }

$taskName = 'Buildbook Local Host'
$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$scriptPath = Join-Path $PSScriptRoot 'start-buildbook-local-host.ps1'
$arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $scriptPath + '"'
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $arguments -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description 'Buildbook local API and optional Telegram host' -Force | Out-Null
if (-not $NoStart) { Start-ScheduledTask -TaskName $taskName }
if ($NoStart) {
  Write-Host 'Автозапуск и восстановление Buildbook установлены для текущего пользователя.'
} else {
  Write-Host 'Автозапуск Buildbook Local Host установлен и запущен для текущего пользователя.'
}
