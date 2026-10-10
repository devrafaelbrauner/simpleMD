// @vitest-environment jsdom
import '../../../packages/core/test/setup-dom';
import { createHash } from 'node:crypto';
import { undo } from '@codemirror/commands';
import { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, it } from 'vitest';
import { setup } from './helpers';

const sha = (bytes: Uint8Array | string | null | undefined) =>
  bytes == null ? null : createHash('sha256').update(bytes).digest('hex');

const views: EditorView[] = [];
afterEach(() => {
  while (views.length) views.pop()?.destroy();
  document.body.innerHTML = '';
});

describe('AC-I1.5 — clique na caixa grava pelo autosave; desfazer volta ao original', () => {
  it('1 byte muda no arquivo; Mod-Z devolve o sha256 original no disco', async () => {
    const text = '# Lista\n\n- [ ] a\n- [ ] b\n';
    const h = await setup({ 'lista.md': text });
    await h.app.sync.openFile('lista.md');
    const record = h.app.registry.get('lista.md')!;
    const parent = document.body.appendChild(document.createElement('div'));
    // O editor da aba: cada transação vai para a sincronização, como no `CodeMirrorEditor`.
    const view: EditorView = new EditorView({
      parent,
      state: record.state,
      dispatchTransactions(trs) {
        view.update(trs);
        h.app.sync.onEditorChange('lista.md', view.state);
      },
    });
    views.push(view);
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    const box = view.contentDOM.querySelector<HTMLElement>('.cm-md-task');
    box!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
    await h.app.sync.flush('lista.md');
    const saved = new TextDecoder().decode(h.port.readBytes('lista.md')!);
    expect(saved).toBe('# Lista\n\n- [x] a\n- [ ] b\n');
    expect([...saved].filter((c, i) => c !== text[i])).toHaveLength(1);
    expect(undo(view)).toBe(true);
    await h.app.sync.flush('lista.md');
    expect(sha(h.port.readBytes('lista.md'))).toBe(sha(text));
  });
});
