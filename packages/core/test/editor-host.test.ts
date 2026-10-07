// @vitest-environment jsdom
import { StateField } from '@codemirror/state';
import { EditorView, ViewPlugin } from '@codemirror/view';
import { undoDepth } from '@codemirror/commands';
import { describe, expect, test } from 'vitest';
import { EditorHost } from '../src';

// AC-6.11 / AC-X.6 (regra 5): ligar e desligar uma extensão de plugin 5× não recria o EditorView e
// mantém documento, seleção e profundidade do desfazer; o efeito some e volta; o campo de outro
// plugin sobrevive às reconfigurações.
describe('EditorHost (compartimentos)', () => {
  test('5 ciclos: 1 EditorView, doc/seleção/desfazer intactos, efeito presente/ausente', () => {
    const host = new EditorHost();
    const marker = ViewPlugin.define(() => ({}));
    const counter = StateField.define<number>({ create: () => 0, update: (v) => v + 1 });
    const parent = document.createElement('div');
    let constructions = 0;
    class CountingView extends EditorView {
      constructor(config: ConstructorParameters<typeof EditorView>[0]) {
        super(config);
        constructions++;
      }
    }
    const view = new CountingView({ state: host.createState('abc', {}), parent });
    view.dispatch({ changes: { from: 3, insert: 'd' }, selection: { anchor: 2 } });
    const before = {
      doc: view.state.doc.toString(),
      sel: view.state.selection.main.head,
      undo: undoDepth(view.state),
    };
    view.dispatch({ effects: host.update({ pluginExtensions: [counter] }) });
    for (let i = 0; i < 5; i++) {
      view.dispatch({ effects: host.update({ pluginExtensions: [counter, marker] }) });
      expect(view.plugin(marker)).not.toBeNull();
      view.dispatch({ effects: host.update({ pluginExtensions: [counter] }) });
      expect(view.plugin(marker)).toBeNull();
      expect(view.state.doc.toString()).toBe(before.doc);
      expect(view.state.selection.main.head).toBe(before.sel);
      expect(undoDepth(view.state)).toBe(before.undo);
    }
    expect(view.state.field(counter)).toBeGreaterThanOrEqual(10);
    expect(constructions).toBe(1);
    view.destroy();
  });

  test('refresh atualiza um estado guardado e é O(1) quando já está na versão atual', () => {
    const host = new EditorHost();
    const stashed = host.createState('x', {});
    expect(host.refresh(stashed)).toBe(stashed);
    const marker = StateField.define<string>({ create: () => 'ok', update: (v) => v });
    host.update({ pluginExtensions: [marker] });
    const fresh = host.refresh(stashed);
    expect(fresh.field(marker)).toBe('ok');
    expect(host.refresh(fresh)).toBe(fresh);
  });
});
