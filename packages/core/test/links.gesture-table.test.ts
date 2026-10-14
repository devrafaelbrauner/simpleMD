// @vitest-environment jsdom
// r14 (AppSec N1, D-R14-08): link renderizado na célula da tabela não navega (AC-R14-2). O
// ⌘/Ctrl-clique e a dica W1 não agem dentro de `.cm-md-table-wrap`; fora da tabela, nada muda.
import { EditorState } from '@codemirror/state';
import { EditorView, hasHoverTooltips } from '@codemirror/view';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  appPlatformFacet,
  createMarkdownExtensions,
  linkOpenerFacet,
  type LinkTarget,
} from '../src';
import { LINK_TIP_DELAY_MS } from '../src/links';
import { fullyParsed } from './helpers/live-preview';

// Tabela SEM `|` inicial: a posição do widget cai no link da 1ª célula.
const DOC =
  'x\n\n[fora](https://example.com/fora)\n\n' +
  '[inicio](https://example.com/inicio) | b\n--- | ---\n[meio](https://example.com/meio) | fim\n';

const views: EditorView[] = [];
afterEach(() => {
  while (views.length) views.pop()?.destroy();
  document.body.innerHTML = '';
  vi.useRealTimers();
});

function mount() {
  const opened: LinkTarget[] = [];
  const state = EditorState.create({
    doc: DOC,
    selection: { anchor: 0 },
    extensions: [
      createMarkdownExtensions(),
      appPlatformFacet.of('mac'),
      linkOpenerFacet.of({ open: (target) => void opened.push(target), noLink: () => {} }),
    ],
  });
  const view = new EditorView({
    state,
    parent: document.body.appendChild(document.createElement('div')),
  });
  views.push(fullyParsed(view));
  const link = (text: string) =>
    [...view.contentDOM.querySelectorAll<HTMLElement>('.cm-md-link')].find(
      (span) => span.textContent === text,
    )!;
  return { view, opened, link };
}

const modClick = (target: Element) =>
  target.dispatchEvent(
    new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, metaKey: true }),
  );

describe('r14: gesto de link dentro da tabela renderizada', () => {
  it('⌘-clique no link do meio da tabela não abre nada; fora da tabela continua abrindo', () => {
    const { opened, link } = mount();
    const meio = link('meio');
    expect(meio.closest('.cm-md-table-wrap')).not.toBeNull();
    modClick(meio);
    expect(opened).toEqual([]);
    modClick(link('fora'));
    expect(opened).toEqual([{ kind: 'external', url: 'https://example.com/fora' }]);
  });

  it('dica W1 não aparece sobre o link da tabela', () => {
    // Só o temporizador e o relógio: o resto falso trava o `hoverTooltip` no jsdom.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const { view, link } = mount();
    link('meio').dispatchEvent(
      new MouseEvent('mousemove', { bubbles: true, clientX: 1, clientY: 1 }),
    );
    vi.advanceTimersByTime(LINK_TIP_DELAY_MS + 100);
    expect(hasHoverTooltips(view.state)).toBe(false);
  });
});
