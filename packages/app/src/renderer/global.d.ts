import type { SweepdeckApi } from '@contracts';

declare global {
  interface Window {
    sweepdeck: SweepdeckApi;
    appInfo: { version: string; platform: string };
  }
}

export {};
