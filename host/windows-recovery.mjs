import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const TASK_NAME = 'Buildbook Local Host';

export async function getWindowsRecoveryStatus({ platform = process.platform, exec = execFileAsync } = {}) {
  if (platform !== 'win32') {
    return Object.freeze({ supported: false, installed: false, state: 'unsupported', restartCount: 0, restartInterval: null });
  }
  const script = "$task = Get-ScheduledTask -TaskName 'Buildbook Local Host' -ErrorAction SilentlyContinue; " +
    "if ($null -eq $task) { [pscustomobject]@{ installed = $false; state = 'Missing'; restartCount = 0; restartInterval = $null } | ConvertTo-Json -Compress; exit 0 }; " +
    "$settings = $task.Settings; [pscustomobject]@{ installed = $true; state = [string]$task.State; restartCount = [int]$settings.RestartCount; restartInterval = [string]$settings.RestartInterval } | ConvertTo-Json -Compress";
  try {
    const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      timeout: 7000,
      maxBuffer: 16 * 1024,
    });
    const result = JSON.parse(String(stdout || '').trim());
    if (!result || typeof result.installed !== 'boolean'
      || !Number.isSafeInteger(result.restartCount) || result.restartCount < 0
      || !(result.restartInterval === null || typeof result.restartInterval === 'string' && result.restartInterval.length <= 64)) {
      throw new Error('Invalid Task Scheduler status.');
    }
    return Object.freeze({
      supported: true,
      installed: result.installed,
      state: typeof result.state === 'string' ? result.state.slice(0, 32) : 'Unknown',
      restartCount: result.restartCount,
      restartInterval: result.restartInterval,
    });
  } catch {
    return Object.freeze({ supported: true, installed: false, state: 'unavailable', restartCount: 0, restartInterval: null });
  }
}

export const BUILDBOOK_RECOVERY_TASK_NAME = TASK_NAME;
