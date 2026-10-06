import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Harness de testes no Chromium (D-6, R-2.12): mesma UI do app com a porta de arquivos em memória.
// Sai em `build/harness` (fora de `dist`, então o Tauri nunca o empacota; token gate T-4).
export default defineConfig({
  root: fileURLToPath(new URL('./harness', import.meta.url)),
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  server: { port: 5174, strictPort: true },
  preview: { port: 4174, strictPort: true },
  build: {
    outDir: fileURLToPath(new URL('./build/harness', import.meta.url)),
    emptyOutDir: true,
  },
});
