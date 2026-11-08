import { app, BrowserWindow } from 'electron';
import { join, resolve } from 'path';
import { existsSync } from 'fs';
import tokens from '@tokens';
import { IPC, type WorkflowEvent } from '@contracts';
import { Engine } from './engine';
import { registerIpc } from './ipc';
import { installDebug, type DebugModule } from './debug';

const SMOKE = process.argv.includes('--smoke');
/** Beta builds only: run the self-test headless, print the result, exit 0/1. */
const SELFTEST = __SWEEPDECK_BETA__ && process.argv.includes('--selftest');
let debug: DebugModule | null = null;
const isDev = !app.isPackaged;

// Single instance lock — focus the existing window instead of opening twice.
// The headless self-test runs alongside a normal instance (it opens no UI and
// scans into a throwaway DB), so it never competes for the lock.
const gotLock = SELFTEST || app.requestSingleInstanceLock();
if (!gotLock) {
  // eslint-disable-next-line no-console
  console.log('SweepDeck is already running — focusing the existing window.');
  app.quit();
} else {
  main();
}

function broadcast(ev: WorkflowEvent): void {
  if (__SWEEPDECK_BETA__) debug?.onWorkflowEvent(ev);
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
      additionalArguments: [`--sweepdeck-version=${app.getVersion()}`, `--sweepdeck-channel=${__SWEEPDECK_CHANNEL__}`],
    },
  });

  if (__SWEEPDECK_BETA__) debug?.attachWindow(win);
  win.once('ready-to-show', () => {
    if (!SELFTEST) win.show();
  });

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
  if (__SWEEPDECK_BETA__) {
    debug = installDebug(engine, __SWEEPDECK_CHANNEL__);
    registerIpc(engine, { onError: (ch, err) => debug?.onIpcError(ch, err) });
  } else {
    registerIpc(engine);
  }

  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin' || SMOKE || SELFTEST) app.quit();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  void app.whenReady().then(() => {
    createWindow();
    if (__SWEEPDECK_BETA__ && SELFTEST && debug) {
      const dbg = debug;
      // let the renderer load so its console errors / crashes are captured too
      setTimeout(() => {
        void dbg
          .runSelfTest()
          .then((report) => {
            const failed = report.checks.filter((c) => !c.ok);
            for (const c of report.checks) {
              // eslint-disable-next-line no-console
              console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.id} — ${c.detail}`);
            }
            for (const e of report.errorsLogged) {
              // eslint-disable-next-line no-console
              console.log(`ERROR ${e.source} — ${e.message}`);
            }
            // eslint-disable-next-line no-console
            console.log(
              `SELFTEST ${report.ok ? 'PASS' : 'FAIL'} (${failed.length} failed check(s), ${report.errorsLogged.length} logged error(s)) report: ${report.reportPath}`,
            );
            app.exit(report.ok ? 0 : 1);
          })
          .catch((err: unknown) => {
            // eslint-disable-next-line no-console
            console.log(`SELFTEST CRASH ${String(err)}`);
            app.exit(2);
          });
      }, 4000);
    } else if (SMOKE) {
      setTimeout(() => {
        // eslint-disable-next-line no-console
        console.log('SMOKE OK');
        app.exit(0);
      }, 3000);
    }
  });
}
