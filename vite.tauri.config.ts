import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { resolve } from 'path';

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: { '@': resolve(__dirname, './src') }
  },
  server: {
    port: Number(process.env.VITE_DEV_PORT) || 1420,
    strictPort: true
  },
  build: {
    outDir: 'dist-tauri',
    emptyOutDir: true
  }
});
