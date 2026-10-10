import { EditorView } from '@codemirror/view';
import type { Extension } from '@codemirror/state';
import { runScopeHandlers } from '@codemirror/view';
import { EditorHost, EMPTY_CONTRIBUTIONS, tableNoticeFacet } from '../../src';

/** Editor montado com a pilha real do `EditorHost` (cadeia, teclas de tabela) para os testes de I-3. */
export interface TableHarness {
  readonly view: EditorView;
  readonly notices: string[];
  readonly announced: string[];
}

const mounted: EditorView[] = [];

export function destroyTableViews(): void {
  while (mounted.length) mounted.pop()?.destroy();
}

export function mountTable(
  doc: string,
  anchor: number,
  opts: { captureTab?: boolean; head?: number; extensions?: Extension[] } = {},
): TableHarness {
  const notices: string[] = [];
  const announced: string[] = [];
  const host = new EditorHost(
    {
      ...EMPTY_CONTRIBUTIONS,
      captureTab: opts.captureTab ?? false,
      pluginExtensions: opts.extensions ?? [],
    },
    [
      tableNoticeFacet.of((text) => notices.push(text)),
      EditorView.updateListener.of((update) => {
        for (const tr of update.transactions)
          for (const effect of tr.effects) if (effect.is(EditorView.announce)) announced.push(effect.value);
      }),
    ],
  );
  const parent = document.createElement('div');
  document.body.append(parent);
  const view = new EditorView({ state: host.createState(doc, { notePath: 'n.md' }), parent });
  view.dispatch({ selection: { anchor, head: opts.head ?? anchor } });
  mounted.push(view);
  return { view, notices, announced };
}

/** Tecla pelo mesmo caminho do CodeMirror (keymaps de escopo `editor`). */
export function press(view: EditorView, key: string, mods: KeyboardEventInit = {}): boolean {
  return runScopeHandlers(
    view,
    new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...mods }),
    'editor',
  );
}

/** Texto selecionado (a célula ativa = seleção, DA-R7-21). */
export function selected(view: EditorView): string {
  const { from, to } = view.state.selection.main;
  return view.state.sliceDoc(from, to);
}
