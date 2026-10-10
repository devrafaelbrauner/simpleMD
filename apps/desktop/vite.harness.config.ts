import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import pkg from './package.json' with { type: 'json' };

/** r7 S5 (D-R7-S5-05): o mesmo plugin de `vite.config.ts` (variante sem DOM no worker do lint). */
const workerWithoutDom = (): Plugin => ({
  name: 'simplemd:worker-sem-dom',
  enforce: 'pre',
  async resolveId(source, importer, options) {
    if (source !== 'decode-named-character-reference') return null;
    const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
    return resolved && { ...resolved, id: resolved.id.replace(/index\.dom\.js$/, 'index.js') };
  },
});

// Harness de testes no Chromium (D-6, R-2.12): mesma UI do app com a porta de arquivos em memória.
// Sai em `build/harness` (fora de `dist`, então o Tauri nunca o empacota; token gate T-4).
export default defineConfig({
  root: fileURLToPath(new URL('./harness', import.meta.url)),
  plugins: [react(), tailwindcss()],
  // r7 S5: o worker do lint resolve a variante sem DOM do `decode-named-character-reference`.
  worker: { plugins: () => [workerWithoutDom()] },
  // Versão do app para `minAppVersion` dos plugins (arch-backend r2 §1.3.1).
  define: { __SIMPLEMD_VERSION__: JSON.stringify(pkg.version) },
  clearScreen: false,
  server: { port: 5174, strictPort: true },
  preview: { port: 4174, strictPort: true },
  build: {
    outDir: fileURLToPath(new URL('./build/harness', import.meta.url)),
    emptyOutDir: true,
    // Fontes woff2 como arquivos (mesma origem), nunca `data:` (arch-frontend §7.3).
    assetsInlineLimit: (file) => (/\.(woff2?|ttf)$/.test(file) ? false : undefined),
  },
});
