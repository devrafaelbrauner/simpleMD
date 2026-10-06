import { EditorSelection, EditorState, type StateCommand } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { createMarkdownState, insertLink, toggleBold, toggleItalic } from '../src';

interface Result {
  handled: boolean;
  doc: string;
  from: number;
  to: number;
  state: EditorState;
}

function apply(cmd: StateCommand, initial: EditorState): Result {
  let state = initial;
  const handled = cmd({ state, dispatch: (tr) => void (state = tr.state) });
  const { from, to } = state.selection.main;
  return { handled, doc: state.doc.toString(), from, to, state };
}

function stateWith(doc: string, anchor: number, head = anchor): EditorState {
  return createMarkdownState(doc).update({ selection: { anchor, head } }).state;
}

describe('toggleBold (AC-1.3)', () => {
  it('seleção "abc" → "**abc**" com "abc" ainda selecionado', () => {
    const r = apply(toggleBold, stateWith('abc', 0, 3));
    expect(r.handled).toBe(true);
    expect(r.doc).toBe('**abc**');
    expect(r.doc.slice(r.from, r.to)).toBe('abc');
    expect([r.from, r.to]).toEqual([2, 5]);
  });

  it('repetir remove os marcadores → "abc" com "abc" selecionado', () => {
    const r = apply(toggleBold, apply(toggleBold, stateWith('abc', 0, 3)).state);
    expect(r.doc).toBe('abc');
    expect([r.from, r.to]).toEqual([0, 3]);
  });

  it('seleção vazia → "****" com o cursor no deslocamento 2', () => {
    const r = apply(toggleBold, stateWith('', 0));
    expect(r.doc).toBe('****');
    expect([r.from, r.to]).toEqual([2, 2]);
  });

  it('preserva a direção da seleção (âncora depois da cabeça)', () => {
    const r = apply(toggleBold, stateWith('abc', 3, 0));
    expect(r.state.selection.main.anchor).toBe(5);
    expect(r.state.selection.main.head).toBe(2);
  });

  it('em "***abc***" remove só o negrito e deixa o itálico', () => {
    const r = apply(toggleBold, stateWith('***abc***', 3, 6));
    expect(r.doc).toBe('*abc*');
    expect(r.doc.slice(r.from, r.to)).toBe('abc');
  });
});

describe('toggleItalic (AC-1.4)', () => {
  it('seleção "abc" → "*abc*" com "abc" ainda selecionado', () => {
    const r = apply(toggleItalic, stateWith('abc', 0, 3));
    expect(r.doc).toBe('*abc*');
    expect([r.from, r.to]).toEqual([1, 4]);
  });

  it('repetir remove os marcadores → "abc"', () => {
    const r = apply(toggleItalic, apply(toggleItalic, stateWith('abc', 0, 3)).state);
    expect(r.doc).toBe('abc');
    expect([r.from, r.to]).toEqual([0, 3]);
  });

  it('seleção vazia → "**" com o cursor no deslocamento 1', () => {
    const r = apply(toggleItalic, stateWith('', 0));
    expect(r.doc).toBe('**');
    expect([r.from, r.to]).toEqual([1, 1]);
  });

  it('"abc" selecionado dentro de "**abc**" vira "***abc***" (não transforma negrito em itálico)', () => {
    const r = apply(toggleItalic, stateWith('**abc**', 2, 5));
    expect(r.doc).toBe('***abc***');
    expect(r.doc.slice(r.from, r.to)).toBe('abc');
    const back = apply(toggleItalic, r.state);
    expect(back.doc).toBe('**abc**');
  });
});

describe('insertLink (AC-1.5)', () => {
  it('seleção "abc" → "[abc](url)" com "url" selecionado', () => {
    const r = apply(insertLink, stateWith('abc', 0, 3));
    expect(r.doc).toBe('[abc](url)');
    expect(r.doc.slice(r.from, r.to)).toBe('url');
    expect([r.from, r.to]).toEqual([6, 9]);
  });

  it('seleção vazia → "[](url)" com o cursor no deslocamento 1', () => {
    const r = apply(insertLink, stateWith('', 0));
    expect(r.doc).toBe('[](url)');
    expect([r.from, r.to]).toEqual([1, 1]);
  });

  it('funciona no meio de uma linha', () => {
    const r = apply(insertLink, stateWith('veja abc aqui', 5, 8));
    expect(r.doc).toBe('veja [abc](url) aqui');
    expect(r.doc.slice(r.from, r.to)).toBe('url');
  });
});

describe('comportamento comum aos comandos', () => {
  it('aplicam a cada seleção (vários cursores)', () => {
    const state = EditorState.create({
      doc: 'um dois',
      selection: EditorSelection.create([EditorSelection.range(0, 2), EditorSelection.range(3, 7)]),
      extensions: EditorState.allowMultipleSelections.of(true),
    });
    const r = apply(toggleBold, state);
    expect(r.doc).toBe('**um** **dois**');
  });

  it.each([
    ['toggleBold', toggleBold],
    ['toggleItalic', toggleItalic],
    ['insertLink', insertLink],
  ])('%s devolve false e não despacha em editor somente leitura', (_name, cmd) => {
    const state = createMarkdownState('abc', { readOnly: true }).update({
      selection: { anchor: 0, head: 3 },
    }).state;
    let dispatched = 0;
    const handled = cmd({ state, dispatch: () => void dispatched++ });
    expect(handled).toBe(false);
    expect(dispatched).toBe(0);
  });
});
