// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';
import { TABLE_TEXT } from '../src';
import { tableEngine } from '../src/tables';
import { destroyTableViews, mountTable, press } from './helpers/tables';

/**
 * r7 S3 — CR-S3-07: se o pedaço do motor não carrega, a tecla de tabela já consumida não some em
 * silêncio (Enter quebra a linha na posição pedida, aviso N1) e a pré-carga não tenta de novo a
 * cada atualização; o próximo comando de tabela tenta.
 */
const chunk = vi.hoisted(() => ({ imports: 0, fail: true }));

vi.mock('@tgrosinger/md-advanced-tables', async (importOriginal) => {
  chunk.imports++;
  if (chunk.fail) throw new Error('pedaço indisponível');
  return importOriginal();
});

afterEach(destroyTableViews);

const T = '|h1|h2|\n|-|-|\n|a|b|';

test('falha de carga: Enter quebra a linha, um aviso, sem nova pré-carga; comando tenta de novo', async () => {
  const { view, notices } = mountTable(T, T.length);
  await vi.waitFor(() => expect(chunk.imports).toBe(1));

  // Enter numa tabela antes do motor: consumido agora, aplicado quando a carga termina.
  expect(press(view, 'Enter')).toBe(true);
  await vi.waitFor(() => expect(notices).toEqual([TABLE_TEXT.unavailable]));
  expect(view.state.doc.toString()).toBe(`${T}\n`);
  expect(view.state.selection.main.head).toBe(T.length + 1);
  expect(tableEngine()).toBeNull();
  const afterFailure = chunk.imports;

  // A pré-carga não tenta de novo a cada atualização com a tabela visível.
  for (let i = 0; i < 5; i++) {
    view.dispatch({ selection: { anchor: 1 + i } });
    view.dispatch({ changes: { from: T.length, insert: ' ' } });
  }
  await vi.dynamicImportSettled();
  expect(chunk.imports).toBe(afterFailure);

  // Um comando explícito tenta de novo e, carregado, aplica.
  chunk.fail = false;
  view.dispatch({ selection: { anchor: 1 } });
  expect(press(view, 'f', { ctrlKey: true, shiftKey: true })).toBe(true);
  await vi.waitFor(() => expect(tableEngine()).not.toBeNull());
  await vi.waitFor(() => expect(view.state.doc.line(1).text).toBe('| h1  | h2  |'));
  expect(chunk.imports).toBe(afterFailure + 1);
  expect(notices).toEqual([TABLE_TEXT.unavailable]);
});
