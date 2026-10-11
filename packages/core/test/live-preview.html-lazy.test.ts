// @vitest-environment jsdom
// NFR-54 (r7 bundle): o sanitizador do HTML cru (DOMPurify + política) é um pedaço sob demanda.
// Nota sem HTML → o pedaço nunca é pedido; primeiro bloco HTML → o pedido sai, o bloco mostra a
// fonte como texto inerte e o grupo em linha fica cru; quando o pedaço chega, os dois viram widget
// (o mesmo desenho do r7 S10). Arquivo próprio: o estado do módulo (`load.ts`) começa vazio aqui.
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMarkdownExtensions, liveCounters, loadHtmlSanitizer, noteContext } from '../src';
import { htmlSanitizerPending, loadedHtmlSanitizer } from '../src/sanitize/load';
import { fullyParsed } from './helpers/live-preview';

/** O pedaço `sanitizer` só termina de carregar quando o teste libera (`release`). */
const chunk = vi.hoisted(() => {
  const { promise: gate, resolve: release } = Promise.withResolvers<void>();
  return { evaluated: 0, gate, release };
});
vi.mock('../src/sanitize/sanitizer', async (importOriginal) => {
  chunk.evaluated++;
  await chunk.gate;
  return importOriginal();
});

const views: EditorView[] = [];
afterEach(() => {
  while (views.length) views.pop()?.destroy();
  document.body.innerHTML = '';
});

function stateOf(doc: string): EditorState {
  return EditorState.create({
    doc,
    selection: { anchor: doc.length },
    extensions: [createMarkdownExtensions(), noteContext.of({ path: 'notas/html.md' })],
  });
}

function mount(state: EditorState): EditorView {
  const parent = document.body.appendChild(document.createElement('div'));
  const view = new EditorView({ state, parent });
  views.push(view);
  return fullyParsed(view);
}

const BLOCK = '<details>\n<summary>Resumo</summary>\n<p>corpo <mark>x</mark></p>\n</details>';
const DOC = ['# Nota', '', BLOCK, '', 'Teclas <kbd>C</kbd> aqui.', '', 'fim'].join('\n');

describe('NFR-54: sanitizador do HTML sob demanda', () => {
  it('nota sem HTML cru: o pedaço do sanitizador nunca é pedido', () => {
    mount(
      stateOf(
        [
          '# Título',
          '',
          'a < b e 2 > 1, `<kbd>` em código',
          '',
          '| a | b |',
          '|---|---|',
          '| 1 | 2 |',
        ].join('\n'),
      ),
    );
    expect(htmlSanitizerPending()).toBeNull();
    expect(loadedHtmlSanitizer()).toBeNull();
    expect(chunk.evaluated).toBe(0);
  });

  it('primeiro bloco HTML: fonte como texto até o pedaço chegar; depois o widget, sem editar nada', async () => {
    // Estado criado ANTES da carga e montado depois (troca de aba): desenha direto o widget.
    const early = stateOf(DOC);
    const view = mount(stateOf(DOC));
    // Widget de bloco desmontado antes da carga: não é preenchido depois (sem assinaturas soltas).
    const gone = mount(stateOf(BLOCK));
    const goneFrame = gone.contentDOM.querySelector<HTMLElement>('[data-testid=html-widget]')!;
    gone.destroy();

    // O pedido saiu no primeiro desenho do bloco (carga em curso, ainda sem sanitizador).
    expect(htmlSanitizerPending()).not.toBeNull();
    expect(loadedHtmlSanitizer()).toBeNull();
    const frame = view.contentDOM.querySelector<HTMLElement>('[data-testid=html-widget]');
    expect(frame?.className).toBe('cm-md-html cm-md-html-pending');
    // Texto inerte: nenhum elemento da nota no DOM enquanto o sanitizador não passou.
    expect(frame?.textContent).toBe(BLOCK);
    expect(frame?.children.length).toBe(0);
    expect(view.contentDOM.querySelector('summary, mark, kbd')).toBeNull();
    expect(view.contentDOM.querySelector('[data-testid=html-inline]')).toBeNull();
    expect(view.contentDOM.textContent).toContain('<kbd>C</kbd>');
    const runs = liveCounters.sanitizeRuns;

    chunk.release();
    // Mesma promessa da carga: o `then` do widget e o `redecorate` do carregador já rodaram.
    await loadHtmlSanitizer();

    expect(loadedHtmlSanitizer()).not.toBeNull();
    expect(view.state.doc.toString()).toBe(DOC);
    const done = view.contentDOM.querySelector<HTMLElement>('[data-testid=html-widget]');
    expect(done?.className).toBe('cm-md-html');
    expect(done?.querySelector('summary')?.textContent).toBe('Resumo');
    expect(done?.querySelector('mark')?.className).toBe('cm-md-mark');
    expect(view.contentDOM.querySelector('[data-testid=html-inline] kbd')?.className).toBe(
      'cm-md-kbd',
    );
    expect(liveCounters.sanitizeRuns).toBeGreaterThan(runs);
    expect(goneFrame.className).toBe('cm-md-html cm-md-html-pending');
    expect(goneFrame.querySelector('summary')).toBeNull();

    const later = mount(early);
    const direct = later.contentDOM.querySelector<HTMLElement>('[data-testid=html-widget]');
    expect(direct?.className).toBe('cm-md-html');
    expect(direct?.querySelector('summary')?.textContent).toBe('Resumo');
    expect(later.contentDOM.querySelector('[data-testid=html-inline] kbd')).not.toBeNull();
    // O pedaço foi avaliado uma vez só (uma instância por janela, editor e exportação).
    expect(chunk.evaluated).toBe(1);
    expect(await loadHtmlSanitizer()).toBe(loadedHtmlSanitizer());
  });
});
