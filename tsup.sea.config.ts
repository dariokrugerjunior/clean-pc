import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/cli/index.ts'],
  format: ['cjs'],
  target: 'node20',
  outDir: 'dist',
  clean: false,          // preserve existing dist/index.js (ESM build)
  splitting: false,
  sourcemap: false,
  dts: false,
  noExternal: [/.*/],   // inline ALL npm deps — required for SEA (no node_modules at runtime)
});
