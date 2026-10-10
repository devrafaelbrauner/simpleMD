import { defineInternalPlugin } from './define';

const USER_SNIPPETS = '.simplemd/latex-snippets.json';

/**
 * Snippets LaTeX (r7 I-6; porte do `obsidian-latex-suite` 1.9.8): desligado por padrão (D-R7-P01).
 * O código do plugin só chega no `import()` de `load` (pedaço sob demanda, NFR-54) e recebe o
 * contexto privado do host (paradas na cadeia de Tab, Esc, paleta, `.simplemd/latex-snippets.json`).
 */
export default defineInternalPlugin({
  id: 'simplemd.latex-snippets',
  name: 'Snippets LaTeX',
  description: 'Atalhos de digitação dentro de $…$ e $$…$$: frações, matrizes, símbolos.',
  defaultEnabled: false,
  order: 70,
  options: [
    { key: 'autofraction', kind: 'boolean', label: 'Fração automática', default: true },
    { key: 'matrixShortcuts', kind: 'boolean', label: 'Atalhos de matriz', default: true },
    {
      key: 'tabout',
      kind: 'boolean',
      label: 'Sair do par com Tab (só com a Tecla Tab no editor)',
      default: true,
    },
    { key: 'autoEnlargeBrackets', kind: 'boolean', label: 'Ampliar delimitadores', default: true },
    {
      key: 'userSnippets',
      kind: 'info',
      label: 'Snippets desta pasta',
      info: async ({ readFile }) => {
        // `import()`: o validador vive no pedaço sob demanda do plugin (0 bytes na partida, NFR-54).
        const [read, { describeUserSnippets }] = await Promise.all([
          readFile(USER_SNIPPETS),
          import('@simplemd/plugins-internal/latex-snippets'),
        ]);
        return describeUserSnippets(read);
      },
    },
  ],
  load: async ({ host }) => {
    const { activate } = await import('@simplemd/plugins-internal/latex-snippets');
    return { default: (api) => activate(api, host) };
  },
});
