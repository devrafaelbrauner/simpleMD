import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import pkg from './package.json' with { type: 'json' };

// Harness de testes no Chromium (D-6, R-2.12): mesma UI do app com a porta de arquivos em memória.
// Sai em `build/harness` (fora de `dist`, então o Tauri nunca o empacota; token gate T-4).
export default defineConfig({
  root: fileURLToPath(new URL('./harness', import.meta.url)),
  plugins: [react(), tailwindcss()],
  // Versão do app para `minAppVersion` dos plugins (arch-backend r2 §1.3.1).
  define: { __SIMPLEMD_VERSION__: JSON.stringify(pkg.version) },
  clearScreen: false,
  server: { port: 5174, strictPort: true },
  preview: { port: 4174, strictPort: true },
  build: {
    outDir: fileURLToPath(new URL('./build/harness', import.meta.url)),
    emptyOutDir: true,
    // Fontes woff2 como arquivos (mesma origem), nunca `data:` (arch-frontend §7.3).
    assetsInlineLimit: (file) => (file.endsWith('.woff2') ? false : undefined),
  },
});
