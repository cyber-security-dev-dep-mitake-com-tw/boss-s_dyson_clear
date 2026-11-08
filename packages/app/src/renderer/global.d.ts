import type { SweepdeckApi } from '@contracts';

export interface DebugLogEntry {
  ts: number;
  level: 'debug' | 'info' | 'warn' | 'error';
  source: string;
  message: string;
  data?: unknown;
}

export interface SelfTestReport {
  ok: boolean;
  startedAt: number;
  finishedAt: number;
  checks: Array<{ id: string; ok: boolean; detail: string }>;
  errorsLogged: DebugLogEntry[];
  reportPath: string | null;
}

/** Present only in beta-channel builds. */
export interface SweepdeckDebugApi {
  info(): Promise<Record<string, unknown>>;
  logs(): Promise<DebugLogEntry[]>;
  exportReport(): Promise<{ ok: boolean; path?: string; error?: string }>;
  selfTest(): Promise<SelfTestReport>;
  onLog(cb: (entry: DebugLogEntry) => void): () => void;
}

declare global {
  interface Window {
    sweepdeck: SweepdeckApi;
    appInfo: { version: string; platform: string; channel?: 'beta' | 'production' };
    sweepdeckDebug?: SweepdeckDebugApi;
  }
}

export {};
