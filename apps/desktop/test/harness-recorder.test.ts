// @vitest-environment jsdom
import '../../../packages/core/test/setup-dom';
import { EditorView } from '@codemirror/view';
import { afterEach, expect, test } from 'vitest';
import { createAnnouncementRecorder } from '../harness/shell';

/** r7 ST H21 (CR-ST-05): uma entrada por anúncio, na região do CM e na da barra de status. */
const cleanup: (() => void)[] = [];
afterEach(() => {
  while (cleanup.length) cleanup.pop()?.();
});

test('cada EditorView.announce vira UMA entrada, inclusive o primeiro e o repetido', async () => {
  const recorder = createAnnouncementRecorder();
  const view = new EditorView({ parent: document.body });
  cleanup.push(() => view.destroy());
  view.dispatch({
    effects: EditorView.announce.of(
      'Tab indenta. Para sair do editor: Esc e depois Tab, ou Ctrl+M.',
    ),
  });
  await Promise.resolve(); // entrega do MutationObserver (microtarefa)
  view.dispatch({ effects: EditorView.announce.of('Tab move o foco') });
  await Promise.resolve();
  view.dispatch({ effects: EditorView.announce.of('Tab move o foco') });
  await Promise.resolve();
  expect(recorder.list()).toEqual([
    { region: 'editor', text: 'Tab indenta. Para sair do editor: Esc e depois Tab, ou Ctrl+M.' },
    { region: 'editor', text: 'Tab move o foco' },
    { region: 'editor', text: 'Tab move o foco' },
  ]);
});

test('região de status: o texto final de cada mudança, sem vazios nem repetição do mesmo texto', async () => {
  const recorder = createAnnouncementRecorder();
  const live = document.createElement('p');
  live.dataset.testid = 'status-live';
  document.body.append(live);
  cleanup.push(() => live.remove());
  live.textContent = 'verificando…';
  // Mesmo lote: o texto muda de novo antes da entrega (só o final conta).
  if (live.firstChild) live.firstChild.nodeValue = 'LanguageTool voltou: 2 problemas.';
  await Promise.resolve();
  live.textContent = 'LanguageTool voltou: 2 problemas.';
  await Promise.resolve();
  live.textContent = '';
  await Promise.resolve();
  live.textContent = 'LanguageTool voltou: 2 problemas.';
  await Promise.resolve();
  expect(recorder.list()).toEqual([
    { region: 'status', text: 'LanguageTool voltou: 2 problemas.' },
    { region: 'status', text: 'LanguageTool voltou: 2 problemas.' },
  ]);
});
