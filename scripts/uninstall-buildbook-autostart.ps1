$ErrorActionPreference = 'Stop'
$taskName = 'Buildbook Local Host'
Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
Write-Host 'Автозапуск Buildbook Local Host удалён.'
