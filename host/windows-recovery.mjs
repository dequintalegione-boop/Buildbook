import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const TASK_NAME = 'Buildbook Local Host';

export async function getWindowsRecoveryStatus({ platform = process.platform, exec = execFileAsync } = {}) {
  if (platform !== 'win32') {
    return Object.freeze({ supported: false, installed: false, state: 'unsupported', restartCount: 0, restartInterval: null });
  }

  const script = String.raw`
$task = Get-ScheduledTask -TaskName 'Buildbook Local Host' -ErrorAction SilentlyContinue
if ($null -eq $task) {
  [pscustomobject]@{
    installed = $false; actionValid = $false; actionIssue = $null; state = 'Missing'
    restartCount = 0; restartInterval = $null; lastRunTime = $null; nextRunTime = $null
    lastTaskResult = $null; lastTaskResultHex = $null
  } | ConvertTo-Json -Compress
  exit 0
}
$settings = $task.Settings
$info = Get-ScheduledTaskInfo -TaskName 'Buildbook Local Host' -ErrorAction Stop
$last = if ($info.LastRunTime -and $info.LastRunTime.Year -gt 1901) { $info.LastRunTime.ToString('o') } else { $null }
$next = if ($info.NextRunTime -and $info.NextRunTime.Year -gt 1901) { $info.NextRunTime.ToString('o') } else { $null }
$action = @($task.Actions) | Select-Object -First 1
$scriptValid = $false
if ($null -ne $action -and -not [string]::IsNullOrWhiteSpace([string]$action.WorkingDirectory)) {
  $expectedScript = Join-Path ([string]$action.WorkingDirectory) 'scripts\start-buildbook-local-host.ps1'
  $scriptValid = ([string]$action.Execute -match '(?i)(^|\\)powershell\.exe$') -and (Test-Path -LiteralPath $expectedScript) -and ([string]$action.Arguments).Contains($expectedScript)
}
$triggerValid = @($task.Triggers | Where-Object {
  $_.CimClass.CimClassName -eq 'MSFT_TaskLogonTrigger' -and $_.Enabled -ne $false
}).Count -gt 0
$principalValid = [string]$task.Principal.RunLevel -eq 'Limited'
$restartCount = [int]$settings.RestartCount
$restartInterval = [string]$settings.RestartInterval
$restartPolicyValid = $restartCount -ge 5 -and $restartInterval -match '^(PT1M|00:01:00|0:01:00)$'
$multipleInstancesValid = [string]$settings.MultipleInstances -eq 'IgnoreNew'
$executionLimitValid = [string]$settings.ExecutionTimeLimit -match '^(PT0S|00:00:00|0:00:00)$'
$actionValid = $scriptValid -and $triggerValid -and $principalValid -and $restartPolicyValid -and $multipleInstancesValid -and $executionLimitValid
$actionIssue = if (-not $scriptValid) { 'Задача не указывает на штатный скрипт запуска Buildbook.' }
  elseif (-not $triggerValid) { 'Для автозапуска не настроен триггер входа пользователя Windows.' }
  elseif (-not $principalValid) { 'Задача должна запускаться с обычными правами текущего пользователя.' }
  elseif (-not $restartPolicyValid) { 'Не настроены пять повторов запуска с интервалом в одну минуту.' }
  elseif (-not $multipleInstancesValid) { 'Не включена защита от параллельных экземпляров локального хоста.' }
  elseif (-not $executionLimitValid) { 'Для фонового хоста задано ограничение времени выполнения задачи.' }
  else { $null }
$result = [uint32]$info.LastTaskResult
[pscustomobject]@{
  installed = $true; actionValid = [bool]$actionValid; actionIssue = $actionIssue
  state = [string]$task.State; restartCount = $restartCount
  restartInterval = $restartInterval; lastRunTime = $last; nextRunTime = $next
  lastTaskResult = [uint32]$result; lastTaskResultHex = ('0x{0:X8}' -f $result)
} | ConvertTo-Json -Compress
`;

  try {
    const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      timeout: 7000,
      maxBuffer: 16 * 1024,
    });
    const result = JSON.parse(String(stdout || '').trim());
    const validOptionalDate = value => value === null || typeof value === 'string'
      && value.length <= 40 && Number.isFinite(Date.parse(value));
    const validResult = value => value === null || Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff;
    if (!result || typeof result.installed !== 'boolean'
      || typeof result.actionValid !== 'boolean'
      || !(result.actionIssue === null || typeof result.actionIssue === 'string' && result.actionIssue.length <= 160)
      || !Number.isSafeInteger(result.restartCount) || result.restartCount < 0
      || !(result.restartInterval === null || typeof result.restartInterval === 'string' && result.restartInterval.length <= 64)
      || !validOptionalDate(result.lastRunTime) || !validOptionalDate(result.nextRunTime)
      || !validResult(result.lastTaskResult)
      || !(result.lastTaskResultHex === null || typeof result.lastTaskResultHex === 'string' && /^0x[0-9A-F]{8}$/.test(result.lastTaskResultHex))) {
      throw new Error('Invalid Task Scheduler status.');
    }
    return Object.freeze({
      supported: true,
      installed: result.installed,
      actionValid: result.actionValid,
      actionIssue: result.actionIssue,
      state: typeof result.state === 'string' ? result.state.slice(0, 32) : 'Unknown',
      restartCount: result.restartCount,
      restartInterval: result.restartInterval,
      lastRunTime: result.lastRunTime,
      nextRunTime: result.nextRunTime,
      lastTaskResult: result.lastTaskResult,
      lastTaskResultHex: result.lastTaskResultHex,
    });
  } catch {
    return Object.freeze({ supported: true, installed: false, actionValid: false, actionIssue: null, state: 'unavailable', restartCount: 0, restartInterval: null, lastRunTime: null, nextRunTime: null, lastTaskResult: null, lastTaskResultHex: null });
  }
}

export const BUILDBOOK_RECOVERY_TASK_NAME = TASK_NAME;
