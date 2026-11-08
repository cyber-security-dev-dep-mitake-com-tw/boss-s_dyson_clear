import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';
import { readFileSync } from 'fs';

const contracts = resolve(__dirname, '../core/src/contracts.ts');
const tokens = resolve(__dirname, '../../design/tokens.json');

/**
 * Release channel — decided at BUILD time so production bundles contain no
 * debug code at all (`if (__SWEEPDECK_BETA__)` branches are dead-code
 * eliminated by the bundler).
 *
 *   1. SWEEPDECK_CHANNEL=beta|production   explicit override (local builds)
 *   2. RELEASE_TAG / GITHUB_REF_NAME        git tag: v1.2.3-beta.1 → beta, v1.2.3 → production
 *   3. packages/app/package.json version    prerelease (1.2.3-rc.1) → beta
 *   default: production
 */
function resolveChannel(): 'beta' | 'production' {
  const explicit = process.env.SWEEPDECK_CHANNEL?.trim().toLowerCase();
  if (explicit === 'beta' || explicit === 'production') return explicit;
  const tag = (process.env.RELEASE_TAG ?? (process.env.GITHUB_REF_TYPE === 'tag' ? process.env.GITHUB_REF_NAME : ''))?.trim();
  if (tag) return /^v?\d+\.\d+\.\d+-/.test(tag) ? 'beta' : 'production';
  try {
    const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8')) as { version?: string };
    if (pkg.version && /^\d+\.\d+\.\d+-/.test(pkg.version)) return 'beta';
  } catch {
    /* default below */
  }
  return 'production';
}

const channel = resolveChannel();
// eslint-disable-next-line no-console
console.log(`[sweepdeck] building channel: ${channel}`);

const define = {
  __SWEEPDECK_BETA__: JSON.stringify(channel === 'beta'),
  __SWEEPDECK_CHANNEL__: JSON.stringify(channel),
};

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    define,
    resolve: { alias: { '@contracts': contracts, '@tokens': tokens } },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    define,
    resolve: { alias: { '@contracts': contracts, '@tokens': tokens } },
  },
  renderer: {
    plugins: [react()],
    define,
    resolve: { alias: { '@contracts': contracts, '@tokens': tokens } },
  },
});
