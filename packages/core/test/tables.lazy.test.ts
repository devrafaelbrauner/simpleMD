// @vitest-environment jsdom
import { undoDepth } from '@codemirror/commands';
import { afterEach, expect, test, vi } from 'vitest';
import { loadTableEngine, tableEngine } from '../src';
import { destroyTableViews, mountTable, press } from './helpers/tables';

/**
 * r7 S3 — V-F22 (D-R7-F27): o motor é um pedaço sob demanda. A pré-carga só começa quando há uma
 * tabela; uma tecla de tabela antes da carga é consumida e aplicada UMA vez quando o `import()`
 * resolve, em ordem, com a posição mapeada pelas edições feitas no meio tempo.
 */
const chunk = vi.hoisted(() => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { gate, release: () => release(), imports: 0 };
});

vi.mock('@tgrosinger/md-advanced-tables', async (importOriginal) => {
  chunk.imports++;
  await chunk.gate;
  return importOriginal();
});

afterEach(destroyTableViews);

test('sem tabela não carrega; com tabela pré-carrega; tecla antes da carga aplica uma vez', async () => {
  mountTable('# Nota sem tabela\n\ntexto', 3);
  await Promise.resolve();
  expect(chunk.imports).toBe(0);

  const T = '|h1|h2|\n|-|-|\n|a|b|';
  const { view, announced } = mountTable(`intro\n\n${T}`, 'intro\n\n|'.length);
  await vi.waitFor(() => expect(chunk.imports).toBe(1));
  expect(tableEngine()).toBeNull();

  // Duas teclas de tabela antes da carga: consumidas, nada muda ainda.
  expect(press(view, 'ArrowRight', { ctrlKey: true, altKey: true })).toBe(true);
  expect(press(view, 'f', { ctrlKey: true, shiftKey: true })).toBe(true);
  expect(view.state.doc.toString()).toBe(`intro\n\n${T}`);

  // Uma edição antes da tabela no meio tempo: a posição pedida é mapeada.
  view.dispatch({ changes: { from: 0, insert: 'novo ' } });

  chunk.release();
  await loadTableEngine();
  await vi.waitFor(() => expect(announced).toHaveLength(1));
  expect(view.state.doc.toString()).toBe(
    'novo intro\n\n| h1  | h2  |\n| --- | --- |\n| a   | b   |',
  );
  // Tab foi para "h2" (selecionada) e o formatar seguinte deixou o cursor na mesma célula.
  const { head } = view.state.selection.main;
  expect(view.state.sliceDoc(head - 2, head)).toBe('h2');
  expect(announced).toEqual(['Cabeçalho, coluna 2']);
  // A edição + 2 comandos (o 2º, formatar uma tabela já formatada, não muda nada).
  expect(undoDepth(view.state)).toBe(2);
  expect(chunk.imports).toBe(1);
});
