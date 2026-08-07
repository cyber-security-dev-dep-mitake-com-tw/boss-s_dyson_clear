import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

const contracts = resolve(__dirname, '../core/src/contracts.ts');
const tokens = resolve(__dirname, '../../design/tokens.json');

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@contracts': contracts, '@tokens': tokens } },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@contracts': contracts, '@tokens': tokens } },
  },
  renderer: {
    plugins: [react()],
    resolve: { alias: { '@contracts': contracts, '@tokens': tokens } },
  },
});
