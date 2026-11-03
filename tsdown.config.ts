import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  treeshake: true,
  minify: false,
  outDir: 'dist',
  target: 'es2022',
  platform: 'node',
  skipNodeModulesBundle: true,
})
