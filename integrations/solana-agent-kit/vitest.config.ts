import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Tests run against this repository's source; the published package resolves @orientimhq/swap from npm.
export default defineConfig({
  resolve: {
    alias: {
      '@orientimhq/swap/solana': fileURLToPath(new URL('../../packages/solana/src/index.ts', import.meta.url)),
      '@orientimhq/swap': fileURLToPath(new URL('../../src/index.ts', import.meta.url)),
    },
  },
});
