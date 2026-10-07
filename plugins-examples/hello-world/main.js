// Exemplo mínimo da API de plugins v1 do simpleMD (docs/plugins.md). ES module puro, sem build:
// importa só módulos do host (as mesmas instâncias do CodeMirror que o app usa).
import { Decoration, EditorView, MatchDecorator, ViewPlugin } from '@codemirror/view';

const helloMark = Decoration.mark({ class: 'cm-hello-world' });
const matcher = new MatchDecorator({ regexp: /hello/gi, decoration: () => helloMark });

const helloDecorations = ViewPlugin.fromClass(
  class {
    constructor(view) {
      this.decorations = matcher.createDeco(view);
    }
    update(update) {
      this.decorations = matcher.updateDeco(update, this.decorations);
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

// Fundo por um token de tema existente: segue o tema claro/escuro do app.
const helloTheme = EditorView.theme({
  '.cm-hello-world': { backgroundColor: 'var(--color-hover)' },
});

export default function activate(api) {
  api.registerCommand('dizer-ola', {
    name: 'Dizer olá',
    hotkey: 'Mod-Shift-H',
    run: () => api.ui.notify('Olá do plugin hello-world!'),
  });
  api.registerEditorExtension({ source: [helloDecorations, helloTheme] });
}
