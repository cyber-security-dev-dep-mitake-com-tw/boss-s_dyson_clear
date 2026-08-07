/**
 * Preload — exposes exactly the SweepdeckApi surface from the frozen contract
 * on window.sweepdeck, plus window.appInfo {version, platform}.
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { IPC, type SweepdeckApi, type WorkflowEvent } from '@contracts';

const api: SweepdeckApi = {
  scanStart: (req) => ipcRenderer.invoke(IPC.scanStart, req),
  scanCancel: (req) => ipcRenderer.invoke(IPC.scanCancel, req),
  onWorkflowEvent: (cb) => {
    const listener = (_e: IpcRendererEvent, ev: WorkflowEvent): void => cb(ev);
    ipcRenderer.on(IPC.workflowEvent, listener);
    return () => {
      ipcRenderer.removeListener(IPC.workflowEvent, listener);
    };
  },
  planGet: (req) => ipcRenderer.invoke(IPC.planGet, req),
  planApprove: (req) => ipcRenderer.invoke(IPC.planApprove, req),
  appsList: () => ipcRenderer.invoke(IPC.appsList, {}),
  appsUninstall: (req) => ipcRenderer.invoke(IPC.appsUninstall, req),
  procsList: () => ipcRenderer.invoke(IPC.procsList, {}),
  procsKill: (req) => ipcRenderer.invoke(IPC.procsKill, req),
  diskStatus: () => ipcRenderer.invoke(IPC.diskStatus, {}),
  diskTrim: (req) => ipcRenderer.invoke(IPC.diskTrim, req),
  graphQuery: (req) => ipcRenderer.invoke(IPC.graphQuery, req),
  receiptsList: () => ipcRenderer.invoke(IPC.receiptsList, {}),
  receiptsUndo: (req) => ipcRenderer.invoke(IPC.receiptsUndo, req),
};

const versionArg = process.argv.find((a) => a.startsWith('--sweepdeck-version='));
const appInfo = {
  version: versionArg ? versionArg.slice('--sweepdeck-version='.length) : '0.0.0',
  platform: process.platform,
};

contextBridge.exposeInMainWorld('sweepdeck', api);
contextBridge.exposeInMainWorld('appInfo', appInfo);
