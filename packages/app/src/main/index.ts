import { app, BrowserWindow } from 'electron';
import { join, resolve } from 'path';
import { existsSync } from 'fs';
import tokens from '@tokens';
import { IPC, type WorkflowEvent } from '@contracts';
import { Engine } from './engine';
import { registerIpc } from './ipc';

const SMOKE = process.argv.includes('--smoke');
const isDev = !app.isPackaged;

// Single instance lock — focus the existing window instead of opening twice.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  main();
}

function broadcast(ev: WorkflowEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(IPC.workflowEvent, ev);
  }
}

function createWindow(): BrowserWindow {
  // Repo-root build/icon.png in dev (out/main → out → app → packages → root).
  const devIcon = resolve(__dirname, '../../../../build/icon.png');

  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1100,
    minHeight: 720,
    show: false,
    backgroundColor: tokens.color.bg.base, // dark bg from design tokens
    ...(isDev && existsSync(devIcon) ? { icon: devIcon } : {}),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: join(__dirname, '../preload/index.js'),
      additionalArguments: [`--sweepdeck-version=${app.getVersion()}`],
    },
  });

  win.once('ready-to-show', () => win.show());

  const rendererUrl = process.env['ELECTRON_RENDERER_URL'];

  // Lock down navigation: the renderer is a local app surface — never open
  // new windows, never navigate away from our own origin/file.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const allowedOrigin = isDev && rendererUrl ? new URL(rendererUrl).origin : null;
  win.webContents.on('will-navigate', (event, url) => {
    if (allowedOrigin) {
      try {
        if (new URL(url).origin === allowedOrigin) return; // dev-server reloads
      } catch {
        /* fall through to deny */
      }
    }
    event.preventDefault();
  });

  if (isDev && rendererUrl) {
    void win.loadURL(rendererUrl);
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'));
  }
  return win;
}

function main(): void {
  const engine = new Engine(broadcast);
  registerIpc(engine);

  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin' || SMOKE) app.quit();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  void app.whenReady().then(() => {
    createWindow();
    if (SMOKE) {
      setTimeout(() => {
        // eslint-disable-next-line no-console
        console.log('SMOKE OK');
        app.exit(0);
      }, 3000);
    }
  });
}
