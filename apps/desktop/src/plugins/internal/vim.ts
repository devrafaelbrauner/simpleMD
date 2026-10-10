import { defineInternalPlugin } from './define';

/**
 * Modo Vim (r7 I-4, `@replit/codemirror-vim` 6.4.0): edição modal, desligado por padrão
 * (D-R7-P01). Recebe só o slot `vim` da barra de status (`PRIVILEGES` em `internal-context.ts`);
 * a precedência dos atalhos globais fica na tabela `app/global-keys.ts` (D-38).
 */
export default defineInternalPlugin({
  id: 'simplemd.vim',
  name: 'Modo Vim',
  description:
    'Edição modal do Vim (normal, inserção, visual). Os atalhos do app continuam valendo.',
  defaultEnabled: false,
  order: 50,
  // `import()` sob demanda: o Vim é um pedaço próprio, 0 bytes na partida (NFR-54).
  load: async ({ host }) => (await import('@simplemd/plugins-internal/vim')).createVimPlugin(host),
});
