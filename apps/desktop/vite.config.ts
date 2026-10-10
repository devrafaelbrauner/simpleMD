import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import pkg from './package.json' with { type: 'json' };

/**
 * r7 S5 (D-R7-S5-05): o worker do lint (markdownlint → micromark) importa
 * `decode-named-character-reference`, cujo `exports` tem `"browser": "./index.dom.js"` (usa
 * `document`) e `"worker": "./index.js"`. O Vite resolve o worker com a condição `browser` e no
 * worker não há `document`; SÓ nos bundles de worker, a resolução vai para a variante de worker do
 * próprio pacote. O mesmo plugin está em `vite.harness.config.ts` (harness = mesma UI).
 */
const workerWithoutDom = (): Plugin => ({
  name: 'simplemd:worker-sem-dom',
  enforce: 'pre',
  async resolveId(source, importer, options) {
    if (source !== 'decode-named-character-reference') return null;
    const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
    return resolved && { ...resolved, id: resolved.id.replace(/index\.dom\.js$/, 'index.js') };
  },
});

// Build de produção do app Tauri: a ÚNICA entrada é `index.html` (o harness do Chromium fica em
// `vite.harness.config.ts` e nunca entra em `dist`; R-2.12). Saída em `dist` (frontendDist).
// As fontes woff2 saem como arquivos da mesma origem, nunca embutidas como `data:` (CSP
// `font-src 'self'`; arch-frontend §7.3).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  // r7 S5: o worker do lint resolve a variante sem DOM do `decode-named-character-reference`.
  worker: { plugins: () => [workerWithoutDom()] },
  // Versão do app para `minAppVersion` dos plugins (arch-backend r2 §1.3.1).
  define: { __SIMPLEMD_VERSION__: JSON.stringify(pkg.version) },
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: ['es2022', 'safari16'],
    assetsInlineLimit: (file) => (/\.(woff2?|ttf)$/.test(file) ? false : undefined),
  },
});
