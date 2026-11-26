import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const TASK_NAME = 'Buildbook Local Host';

export async function getWindowsRecoveryStatus({ platform = process.platform, exec = execFileAsync } = {}) {
  if (platform !== 'win32') {
    return Object.freeze({ supported: false, installed: false, state: 'unsupported', restartCount: 0, restartInterval: null });
  }
  const script = "$task = Get-ScheduledTask -TaskName 'Buildbook Local Host' -ErrorAction SilentlyContinue; " +
    "if ($null -eq $task) { [pscustomobject]@{ installed = $false; state = 'Missing'; restartCount = 0; restartInterval = $null; lastRunTime = $null; nextRunTime = $null; lastTaskResult = $null; lastTaskResultHex = $null } | ConvertTo-Json -Compress; exit 0 }; " +
    "$settings = $task.Settings; $info = Get-ScheduledTaskInfo -TaskName 'Buildbook Local Host' -ErrorAction Stop; " +
    "$last = if ($info.LastRunTime -and $info.LastRunTime.Year -gt 1901) { $info.LastRunTime.ToString('o') } else { $null }; " +
    "$next = if ($info.NextRunTime -and $info.NextRunTime.Year -gt 1901) { $info.NextRunTime.ToString('o') } else { $null }; " +
    "$result = [uint32]$info.LastTaskResult; [pscustomobject]@{ installed = $true; state = [string]$task.State; restartCount = [int]$settings.RestartCount; restartInterval = [string]$settings.RestartInterval; lastRunTime = $last; nextRunTime = $next; lastTaskResult = [uint32]$result; lastTaskResultHex = ('0x{0:X8}' -f $result) } | ConvertTo-Json -Compress";
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
      || !Number.isSafeInteger(result.restartCount) || result.restartCount < 0
      || !(result.restartInterval === null || typeof result.restartInterval === 'string' && result.restartInterval.length <= 64)
      || !validOptionalDate(result.lastRunTime ?? null) || !validOptionalDate(result.nextRunTime ?? null)
      || !validResult(result.lastTaskResult ?? null)
      || !(result.lastTaskResultHex === null || typeof result.lastTaskResultHex === 'string' && /^0x[0-9A-F]{8}$/.test(result.lastTaskResultHex))) {
      throw new Error('Invalid Task Scheduler status.');
    }
    return Object.freeze({
      supported: true,
      installed: result.installed,
      state: typeof result.state === 'string' ? result.state.slice(0, 32) : 'Unknown',
      restartCount: result.restartCount,
      restartInterval: result.restartInterval,
      lastRunTime: result.lastRunTime ?? null,
      nextRunTime: result.nextRunTime ?? null,
      lastTaskResult: result.lastTaskResult ?? null,
      lastTaskResultHex: result.lastTaskResultHex ?? null,
    });
  } catch {
    return Object.freeze({ supported: true, installed: false, state: 'unavailable', restartCount: 0, restartInterval: null });
  }
}

export const BUILDBOOK_RECOVERY_TASK_NAME = TASK_NAME;
