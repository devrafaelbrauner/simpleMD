// @vitest-environment jsdom
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { describe, expect, it } from 'vitest';
import { createMarkdownExtensions, setEditorFocus } from '../src';
import { decorate, previewState } from './helpers/live-preview';
import fixture from './fixtures/live-preview.md?raw';

describe('o live preview nunca altera o texto (AC-3.8, regra 1)', () => {
  it('estado: cursor em cada início de linha, decorações recalculadas, bytes idênticos', () => {
    let state = previewState(fixture, { anchor: 0 });
    for (let n = 1; n <= state.doc.lines; n++) {
      state = state.update({ selection: { anchor: state.doc.line(n).from } }).state;
      decorate(state);
      expect(state.doc.toString()).toBe(fixture);
    }
  });

  it('view: cursor em cada início de linha com foco produz 0 atualizações docChanged', () => {
    let updates = 0;
    let docChanges = 0;
    const parent = document.body.appendChild(document.createElement('div'));
    const view = new EditorView({
      state: EditorState.create({
        doc: fixture,
        extensions: [
          createMarkdownExtensions(),
          EditorView.updateListener.of((update) => {
            updates++;
            if (update.docChanged) docChanges++;
          }),
        ],
      }),
      parent,
    });
    view.dispatch({ effects: setEditorFocus.of(true) });
    for (let n = 1; n <= view.state.doc.lines; n++) {
      view.dispatch({ selection: { anchor: view.state.doc.line(n).from } });
    }
    expect(updates).toBeGreaterThanOrEqual(view.state.doc.lines);
    expect(docChanges).toBe(0);
    expect(view.state.doc.toString()).toBe(fixture);
    view.destroy();
    parent.remove();
  });
});
