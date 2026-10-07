// Gera plugins-examples/calc/main.js a partir de packages/plugins-internal/src/calc (R-7.5;
// arch-frontend r2 §7.5): Vite em modo biblioteca, ESM, sem minificar, com os 4 módulos do host
// externos. O CI roda este script e falha se o arquivo commitado mudar (`git diff --exit-code`).
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const HOST_MODULES = [
  '@codemirror/state',
  '@codemirror/view',
  '@codemirror/language',
  '@codemirror/autocomplete',
];

await build({
  configFile: false,
  root,
  logLevel: 'warn',
  build: {
    lib: {
      entry: fileURLToPath(
        new URL('../packages/plugins-internal/src/calc/index.ts', import.meta.url),
      ),
      formats: ['es'],
      fileName: () => 'main.js',
    },
    outDir: fileURLToPath(new URL('../plugins-examples/calc', import.meta.url)),
    emptyOutDir: false,
    minify: false,
    sourcemap: false,
    target: 'es2022',
    rolldownOptions: {
      external: HOST_MODULES,
      output: {
        banner:
          '// Gerado por scripts/build-plugin-example.mjs a partir de packages/plugins-internal/src/calc.\n// Não edite à mão (o CI confere). API v1: docs/plugins.md.',
      },
    },
  },
});
