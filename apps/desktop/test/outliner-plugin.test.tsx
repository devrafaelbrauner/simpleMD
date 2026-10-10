// @vitest-environment jsdom
import '../../../packages/core/test/setup-dom';
import { createHash } from 'node:crypto';
import { foldedRanges } from '@codemirror/language';
import type { EditorView } from '@codemirror/view';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { App } from '../src/app/App';
import outliner from '../src/plugins/internal/outliner';
import { setup, type Harness } from './helpers';

/**
 * r7 S7 (I-7) no app: o outliner ligado pelo registro real registra os 8 comandos "Lista: …"
 * (STR-174) uma vez por ativação, sem aviso "comando de paleta repetido" ao ligar, desligar e
 * religar (CR-PAL-D01/D02); a dobra não muda os bytes e some ao fechar a aba (AC-I7.3).
 */
afterEach(cleanup);

const IDS = [
  'move-up',
  'move-down',
  'indent',
  'outdent',
  'fold',
  'unfold',
  'fold-all',
  'unfold-all',
];
const TITLES = [
  'Lista: Mover item para cima',
  'Lista: Mover item para baixo',
  'Lista: Indentar item',
  'Lista: Desindentar item',
  'Lista: Dobrar item',
  'Lista: Desdobrar item',
  'Lista: Dobrar tudo',
  'Lista: Desdobrar tudo',
];
const DOC = '- um\n  - um.a\n  - um.b\n- dois\n';

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

async function openWithOutliner(): Promise<{ h: Harness; view: () => EditorView }> {
  const h = await setup({ 'nota.md': DOC }, { internalDescriptors: [outliner] });
  render(<App app={h.app} />);
  await act(async () => {
    await h.app.sync.openFile('nota.md');
  });
  const view = () => {
    const v = h.app.plugins.editor.view;
    if (!v) throw new Error('editor não montado');
    return v;
  };
  return { h, view };
}

function outlinerCommandIds(h: Harness): string[] {
  return IDS.flatMap((id) =>
    h.app.plugins.commands.get(`simplemd.outliner:${id}`) ? [`simplemd.outliner:${id}`] : [],
  );
}

test('ligar, desligar e religar: 8 comandos "Lista: …" com o título exato e 0 avisos de comando repetido (CR-PAL-D01)', async () => {
  const warn = vi.spyOn(console, 'warn');
  const { h } = await openWithOutliner();
  const { host } = h.app.plugins;

  await act(async () => {
    await host.setEnabled('simplemd.outliner', true);
  });
  await vi.waitFor(() => expect(outlinerCommandIds(h)).toHaveLength(8));
  expect(IDS.map((id) => h.app.plugins.commands.get(`simplemd.outliner:${id}`)?.title)).toEqual(
    TITLES,
  );

  await act(async () => {
    await host.setEnabled('simplemd.outliner', false);
  });
  await vi.waitFor(() => expect(outlinerCommandIds(h)).toHaveLength(0));

  await act(async () => {
    await host.setEnabled('simplemd.outliner', true);
  });
  await vi.waitFor(() => expect(outlinerCommandIds(h)).toHaveLength(8));

  const repeated = warn.mock.calls.filter((call) => String(call[0]).includes('repetido'));
  expect(repeated).toEqual([]);
  warn.mockRestore();
});

test('dobrar pelo comando não muda os bytes (sha256) e a dobra some ao fechar e reabrir a aba (AC-I7.3)', async () => {
  const { h, view } = await openWithOutliner();
  await act(async () => {
    await h.app.plugins.host.setEnabled('simplemd.outliner', true);
  });
  await vi.waitFor(() => expect(outlinerCommandIds(h)).toHaveLength(8));
  const before = sha256(view().state.doc.toString());

  view().dispatch({ selection: { anchor: 2 } });
  await act(async () => {
    await h.app.plugins.commands.get('simplemd.outliner:fold')?.run();
  });
  expect(foldedRanges(view().state).size).toBe(1);
  expect(sha256(view().state.doc.toString())).toBe(before);

  await act(async () => {
    await h.app.plugins.commands.get('simplemd.outliner:unfold')?.run();
  });
  expect(foldedRanges(view().state).size).toBe(0);
  expect(sha256(view().state.doc.toString())).toBe(before);

  await act(async () => {
    await h.app.plugins.commands.get('simplemd.outliner:fold-all')?.run();
  });
  expect(foldedRanges(view().state).size).toBe(1);
  await act(async () => {
    expect(await h.app.sync.closeTab('nota.md')).toBe('ok');
  });
  expect(sha256(h.port.readText('nota.md') ?? '')).toBe(before);
  await act(async () => {
    await h.app.sync.openFile('nota.md');
  });
  expect(view().state.doc.toString()).toBe(DOC);
  expect(foldedRanges(view().state).size).toBe(0);
});
