import test from 'node:test';
import assert from 'node:assert/strict';
import { getWindowsRecoveryStatus, BUILDBOOK_RECOVERY_TASK_NAME } from '../host/windows-recovery.mjs';

const validTask = {
  installed: true,
  actionValid: true,
  actionIssue: null,
  state: 'Ready',
  restartCount: 5,
  restartInterval: 'PT1M',
  lastRunTime: '2026-11-27T10:00:00.000Z',
  nextRunTime: null,
  lastTaskResult: 0,
  lastTaskResultHex: '0x00000000',
};

function fakeExec(payload) {
  return async (command, args, options) => {
    assert.equal(command, 'powershell.exe');
    assert.ok(args.includes('-NonInteractive'));
    assert.equal(options.timeout, 7000);
    return { stdout: JSON.stringify(payload) };
  };
}

test('Windows recovery status is unsupported outside Windows', async () => {
  const result = await getWindowsRecoveryStatus({ platform: 'linux' });
  assert.equal(result.supported, false);
  assert.equal(result.state, 'unsupported');
});

test('Windows recovery status reports a fully configured task', async () => {
  const result = await getWindowsRecoveryStatus({ platform: 'win32', exec: fakeExec(validTask) });
  assert.equal(BUILDBOOK_RECOVERY_TASK_NAME, 'Buildbook Local Host');
  assert.equal(result.supported, true);
  assert.equal(result.installed, true);
  assert.equal(result.actionValid, true);
  assert.equal(result.restartCount, 5);
  assert.equal(result.restartInterval, 'PT1M');
  assert.equal(result.lastTaskResultHex, '0x00000000');
});

test('Windows recovery status preserves an actionable task configuration issue', async () => {
  const result = await getWindowsRecoveryStatus({
    platform: 'win32',
    exec: fakeExec({ ...validTask, actionValid: false, actionIssue: 'Не настроен триггер входа Windows.' }),
  });
  assert.equal(result.installed, true);
  assert.equal(result.actionValid, false);
  assert.equal(result.actionIssue, 'Не настроен триггер входа Windows.');
});

test('Windows recovery status fails closed for malformed scheduler output', async () => {
  const result = await getWindowsRecoveryStatus({
    platform: 'win32',
    exec: fakeExec({ ...validTask, restartCount: '5' }),
  });
  assert.equal(result.supported, true);
  assert.equal(result.installed, false);
  assert.equal(result.actionValid, false);
  assert.equal(result.state, 'unavailable');
});

test('Windows recovery status fails closed when Task Scheduler cannot be queried', async () => {
  const result = await getWindowsRecoveryStatus({
    platform: 'win32',
    exec: async () => { throw new Error('access denied'); },
  });
  assert.equal(result.supported, true);
  assert.equal(result.installed, false);
  assert.equal(result.state, 'unavailable');
});
