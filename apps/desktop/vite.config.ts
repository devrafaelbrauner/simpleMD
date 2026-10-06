import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Build de produção do app Tauri: a ÚNICA entrada é `index.html` (o harness do Chromium fica em
// `vite.harness.config.ts` e nunca entra em `dist`; R-2.12). Saída em `dist` (frontendDist).
// As fontes woff2 saem como arquivos da mesma origem, nunca embutidas como `data:` (CSP
// `font-src 'self'`; arch-frontend §7.3).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: ['es2022', 'safari16'],
    assetsInlineLimit: (file) => (file.endsWith('.woff2') ? false : undefined),
  },
});
