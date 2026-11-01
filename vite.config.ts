import { defineConfig } from 'vite';
import path from 'node:path';

export default defineConfig({
  root: 'src/renderer',
  base: './',
  // 大きな GeoJSON を JS オブジェクトリテラルではなく JSON.parse として
  // バンドルし、起動時のパースを速くする
  json: { stringify: true },
  build: {
    outDir: path.resolve(__dirname, 'dist/renderer'),
    emptyOutDir: true,
  },
});
