// @vitest-environment jsdom
import { EditorState } from '@codemirror/state';
import { afterEach, beforeAll, describe, expect, test } from 'vitest';
import { loadTableEngine, TABLE_TEXT } from '../src';
import { destroyTableViews, mountTable, press, selected } from './helpers/tables';

/**
 * r7 S3 — teclas da tabela pela pilha real do `EditorHost`: cadeia de contexto slot `table` (300)
 * para Tab/Shift-Tab (só com `editor.captureTab`) e `Mod-Alt-→/←` (sempre); Enter/Shift-Enter
 * (D-43, AC-I3.5); `Mod-Shift-F` (UX-R7-D20). A parte PW de AC-I3.4/I3.5 fica com a QA.
 */
beforeAll(async () => {
  await loadTableEngine();
});
afterEach(destroyTableViews);

const T = '|h1|h2|\n|-|-|\n|a|b|';
const FORMATTED = '| h1  | h2  |\n| --- | --- |\n| a   | b   |';
const CTRL_ALT = { ctrlKey: true, altKey: true };

describe('Mod-Shift-F — Formatar tabela', () => {
  test('na tabela formata (um passo); fora dela avisa e não muda nada', () => {
    const inside = mountTable(T, 1);
    expect(press(inside.view, 'f', { ctrlKey: true, shiftKey: true })).toBe(true);
    expect(inside.view.state.doc.toString()).toBe(FORMATTED);
    const doc = `texto\n\n${T}`;
    const outside = mountTable(doc, 2);
    expect(press(outside.view, 'f', { ctrlKey: true, shiftKey: true })).toBe(true);
    expect(outside.notices).toEqual([TABLE_TEXT.outside]);
    expect(outside.view.state.doc.toString()).toBe(doc);
  });

  test('somente leitura: a tecla não é consumida', () => {
    const { view } = mountTable(T, 1, { extensions: [EditorState.readOnly.of(true)] });
    expect(press(view, 'f', { ctrlKey: true, shiftKey: true })).toBe(false);
    expect(view.state.doc.toString()).toBe(T);
  });
});

describe('AC-I3.4 (VT) — Tab pela cadeia só com a chave; Mod-Alt-→/← sempre', () => {
  test('chave ligada: Tab percorre formatando, na última cria linha; Shift-Tab volta', () => {
    const { view, announced } = mountTable(T, 1, { captureTab: true });
    expect(press(view, 'Tab')).toBe(true);
    expect(selected(view)).toBe('h2');
    expect(view.state.doc.toString()).toBe(FORMATTED);
    press(view, 'Tab');
    press(view, 'Tab');
    expect(selected(view)).toBe('b');
    press(view, 'Tab');
    expect(view.state.doc.toString()).toBe(`${FORMATTED}\n|     |     |`);
    expect(press(view, 'Tab', { shiftKey: true })).toBe(true);
    expect(selected(view)).toBe('b');
    expect(announced).toEqual([
      TABLE_TEXT.header(2),
      TABLE_TEXT.row(1, 1),
      TABLE_TEXT.row(1, 2),
      TABLE_TEXT.created,
      TABLE_TEXT.row(1, 2),
    ]);
  });

  test('chave desligada: Tab não é tratado pelo editor (sai) e o documento não muda', () => {
    const { view } = mountTable(T, 1, { captureTab: false });
    expect(press(view, 'Tab')).toBe(false);
    expect(press(view, 'Tab', { shiftKey: true })).toBe(false);
    expect(view.state.doc.toString()).toBe(T);
  });

  test('chave desligada: Mod-Alt-→/← fazem o mesmo que Tab/Shift-Tab', () => {
    const { view } = mountTable(T, 1, { captureTab: false });
    expect(press(view, 'ArrowRight', CTRL_ALT)).toBe(true);
    expect(selected(view)).toBe('h2');
    expect(press(view, 'ArrowRight', CTRL_ALT)).toBe(true);
    expect(selected(view)).toBe('a');
    expect(press(view, 'ArrowLeft', CTRL_ALT)).toBe(true);
    expect(selected(view)).toBe('h2');
  });

  test('fora de tabela de topo a cadeia segue: tabela numa lista → item de lista indentado', () => {
    const doc = '- um\n- dois\n\n  | a | b |\n  |---|---|';
    const { view, notices } = mountTable(doc, doc.indexOf('| a') + 2, { captureTab: true });
    expect(press(view, 'Tab')).toBe(true);
    expect(notices).toEqual([]);
    expect(view.state.doc.toString()).not.toContain('| a   |');
    // Mod-Alt-→ fora de tabela e sem paradas: ninguém aceita, a tecla passa.
    const plain = mountTable('texto', 1);
    expect(press(plain.view, 'ArrowRight', CTRL_ALT)).toBe(false);
    expect(plain.view.state.doc.toString()).toBe('texto');
  });
});

describe('AC-I3.5 (VT) — Enter e Shift-Enter', () => {
  test('Enter: próxima linha na mesma coluna; no fim cria linha formatada', () => {
    const doc = '|h1|h2|\n|-|-|\n|a|b|\n|c|d|';
    const { view, announced } = mountTable(doc, doc.indexOf('b'));
    expect(press(view, 'Enter')).toBe(true);
    expect(selected(view)).toBe('d');
    expect(press(view, 'Enter')).toBe(true);
    expect(view.state.doc.toString()).toBe(
      '| h1  | h2  |\n| --- | --- |\n| a   | b   |\n| c   | d   |\n|     |     |',
    );
    const line = view.state.doc.lineAt(view.state.selection.main.head);
    expect(line.number).toBe(5);
    expect(view.state.selection.main.head - line.from).toBe('|     | '.length);
    expect(announced).toEqual([TABLE_TEXT.row(2, 2), TABLE_TEXT.created]);
  });

  test('Shift-Enter: quebra de linha comum, sem formatar', () => {
    const { view } = mountTable(T, T.indexOf('a|b') + 1);
    expect(press(view, 'Enter', { shiftKey: true })).toBe(true);
    expect(view.state.doc.toString()).toBe('|h1|h2|\n|-|-|\n|a\n|b|');
  });

  test('fora de tabela Enter não muda: parágrafo quebra a linha, lista continua o item', () => {
    const para = mountTable('linha', 5);
    expect(press(para.view, 'Enter')).toBe(true);
    expect(para.view.state.doc.toString()).toBe('linha\n');
    const list = mountTable('- item', 6);
    expect(press(list.view, 'Enter')).toBe(true);
    expect(list.view.state.doc.toString()).toBe('- item\n- ');
    expect(para.notices).toEqual([]);
    expect(para.announced).toEqual([]);
  });

  test('tabela dentro de lista: Enter segue o comportamento da lista (não é da tabela)', () => {
    const doc = '- item\n\n  | a | b |\n  |---|---|\n  | 1 | 2 |';
    const { view, notices, announced } = mountTable(doc, doc.length);
    press(view, 'Enter');
    expect(view.state.doc.toString().startsWith(doc)).toBe(true);
    expect(view.state.doc.toString()).not.toContain('| 1   |');
    expect(notices).toEqual([]);
    expect(announced).toEqual([]);
  });
});
