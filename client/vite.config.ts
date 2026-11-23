import { readFile, readdir } from 'node:fs/promises';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

function bundlePdfAssets(): Plugin {
  const pdfDirectory = new URL('./node_modules/pdfjs-dist/', import.meta.url);
  return {
    name: 'pdf-preview-assets',
    apply: 'build',
    async generateBundle() {
      for (const directory of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) {
        const sourceDirectory = new URL(`${directory}/`, pdfDirectory);
        for (const file of await readdir(sourceDirectory)) {
          this.emitFile({
            type: 'asset',
            fileName: `pdf-assets/${directory}/${file}`,
            source: await readFile(new URL(file, sourceDirectory)),
          });
        }
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), bundlePdfAssets()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3001',
        changeOrigin: true,
      },
      '/uploads': {
        target: 'http://127.0.0.1:3001',
        changeOrigin: true,
      },
    },
  },
});
