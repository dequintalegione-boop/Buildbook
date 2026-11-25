const { app, BrowserWindow, dialog } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');

let windowRef;
let hostProcess;
let stopping = false;
let restartTimer;

const hostEntry = () => path.join(app.getAppPath(), 'host', 'run-buildbook-local-host.mjs');

function startLocalHost() {
  if (stopping || hostProcess) return;
  const entry = hostEntry();
  hostProcess = spawn(process.execPath, [entry], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: 'ignore',
    windowsHide: true,
  });
  hostProcess.once('error', (error) => {
    console.error('Buildbook local host launch failed:', error.message);
  });
  hostProcess.once('exit', (code, signal) => {
    hostProcess = undefined;
    if (stopping) return;
    console.warn('Buildbook local host stopped:', { code, signal });
    restartTimer = setTimeout(startLocalHost, 2500);
  });
}

function stopLocalHost() {
  stopping = true;
  if (restartTimer) clearTimeout(restartTimer);
  if (hostProcess && !hostProcess.killed) hostProcess.kill();
  hostProcess = undefined;
}

function createWindow() {
  windowRef = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1024,
    minHeight: 700,
    title: 'Buildbook',
    backgroundColor: '#111318',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  windowRef.loadFile(path.join(app.getAppPath(), 'index.html'));
  windowRef.on('closed', () => { windowRef = undefined; });
}

app.whenReady().then(() => {
  startLocalHost();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', stopLocalHost);
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

process.on('uncaughtException', async (error) => {
  console.error('Buildbook desktop error:', error);
  if (windowRef) await dialog.showMessageBox(windowRef, {
    type: 'error',
    title: 'Buildbook',
    message: 'Произошла ошибка приложения.',
    detail: 'Локальный компонент будет перезапущен при следующем запуске Buildbook.',
  });
});
