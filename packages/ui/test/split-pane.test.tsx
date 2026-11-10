import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  PREVIEW_PANE_TEXT,
  PreviewPane,
  SPLIT_MIN_PANE_PX,
  SPLIT_MIN_WIDTH_PX,
  SplitPane,
  type PreviewPaneProps,
  type SplitPaneProps,
} from '../src';

/**
 * r38b (design-r38 §1, §7 AC-R38-2): o divisor da prévia lado a lado (aria, teclado, arraste com um
 * único commit, Esc, duplo clique, 320/900 px, o `start` sempre no mesmo nó) e o painel da prévia.
 * O jsdom não faz layout: larguras pelo `ResizeObserver` falso e por `getBoundingClientRect`.
 */
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** `ResizeObserver` falso: o teste entrega a largura medida. */
class FakeResizeObserver {
  static last: FakeResizeObserver | null = null;
  readonly #callback: ResizeObserverCallback;

  constructor(callback: ResizeObserverCallback) {
    this.#callback = callback;
    FakeResizeObserver.last = this;
  }

  observe(): void {}

  disconnect(): void {}

  resize(width: number): void {
    const entry = { contentRect: { width } } as ResizeObserverEntry;
    act(() => this.#callback([entry], this as unknown as ResizeObserver));
  }
}

function withResizeObserver(): () => FakeResizeObserver {
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  return () => {
    if (!FakeResizeObserver.last) throw new Error('ResizeObserver não criado');
    return FakeResizeObserver.last;
  };
}

/** Área de 1024 px com o divisor de 24 px: 1000 px úteis (50 % = 500 px por lado). */
function layout(width = 1024): void {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    const w = this.classList.contains('smd-split-separator') ? 24 : width;
    return { x: 0, y: 0, top: 0, left: 0, right: w, bottom: 600, width: w, height: 600 } as DOMRect;
  });
}

type Props = Partial<SplitPaneProps>;

function renderSplit(props: Props = {}) {
  const onRatioChange = vi.fn<(ratio: number) => void>();
  const onFitChange = vi.fn<(fits: boolean, width: number) => void>();
  const view = (extra: Props) => (
    <SplitPane
      start={<div data-testid="start-node">editor</div>}
      end={<div data-testid="end-node">prévia</div>}
      startId="split-start"
      ratio={0.5}
      onRatioChange={onRatioChange}
      onFitChange={onFitChange}
      separatorLabel="Redimensionar editor e prévia"
      startLabel="Editor"
      endLabel="prévia"
      {...props}
      {...extra}
    />
  );
  const result = render(view({}));
  return {
    ...result,
    onRatioChange,
    onFitChange,
    rerenderWith: (extra: Props) => result.rerender(view(extra)),
  };
}

const separator = () => screen.getByRole('separator');
const key = (name: string, init: KeyboardEventInit = {}) =>
  fireEvent.keyDown(separator(), { key: name, ...init });

describe('SplitPane: estrutura e aria (design-r38 §1)', () => {
  test('o `start` é o mesmo nó quando a prévia entra e sai; sem `end`, sem divisor', () => {
    const r = renderSplit({ end: null });
    const node = screen.getByTestId('start-node');
    expect(screen.queryByRole('separator')).toBeNull();
    expect(r.container.querySelector('.smd-split')?.getAttribute('data-split')).toBe('off');

    r.rerenderWith({ end: <div data-testid="end-node">prévia</div> });
    expect(screen.getByTestId('start-node')).toBe(node);
    expect(separator()).toBeTruthy();
    expect(r.container.querySelector('.smd-split')?.getAttribute('data-split')).toBe('on');
    // O `start` é sempre o primeiro filho (o editor nunca muda de lugar no DOM).
    expect(r.container.querySelector('.smd-split')?.firstElementChild?.id).toBe('split-start');

    r.rerenderWith({ end: null });
    expect(screen.getByTestId('start-node')).toBe(node);
    expect(node.isConnected).toBe(true);
  });

  test('separator vertical focável com nome, valor inteiro, limites e texto dos dois lados', () => {
    renderSplit({ ratio: 0.55 });
    const el = separator();
    expect(el.getAttribute('aria-orientation')).toBe('vertical');
    expect(el.getAttribute('aria-label')).toBe('Redimensionar editor e prévia');
    expect(el.getAttribute('aria-controls')).toBe('split-start');
    expect(document.getElementById('split-start')).not.toBeNull();
    expect(el.tabIndex).toBe(0);
    expect(el.getAttribute('aria-valuenow')).toBe('55');
    // Sem medida: a faixa gravável 0,1–0,9.
    expect(el.getAttribute('aria-valuemin')).toBe('10');
    expect(el.getAttribute('aria-valuemax')).toBe('90');
    expect(el.getAttribute('aria-valuetext')).toBe('Editor 55%, prévia 45%');
  });

  test('a proporção vira a largura do editor (`--smd-split-ratio`) e fica dentro dos limites', () => {
    const resize = withResizeObserver();
    const r = renderSplit({ ratio: 0.1 });
    const root = r.container.querySelector<HTMLElement>('.smd-split');
    expect(root?.style.getPropertyValue('--smd-split-ratio')).toBe('0.1');
    // 1024 px de área → 1000 úteis: 320 px por lado = 32 %…68 %; a gravada (0,1) é só mostrada no
    // limite, nada é gravado por isso.
    resize().resize(1024);
    expect(root?.style.getPropertyValue('--smd-split-ratio')).toBe(
      String(SPLIT_MIN_PANE_PX / 1000),
    );
    expect(separator().getAttribute('aria-valuenow')).toBe('32');
    expect(r.onRatioChange).not.toHaveBeenCalled();
  });
});

describe('SplitPane: 320/900 px pelo ResizeObserver', () => {
  test('cabe a partir de 900 px; escondido (0 px) e largura repetida não avisam', () => {
    const resize = withResizeObserver();
    const r = renderSplit();
    resize().resize(1024);
    expect(r.onFitChange).toHaveBeenLastCalledWith(true, 1024);
    expect(separator().getAttribute('aria-valuemin')).toBe('32');
    expect(separator().getAttribute('aria-valuemax')).toBe('68');
    resize().resize(SPLIT_MIN_WIDTH_PX - 1);
    expect(r.onFitChange).toHaveBeenLastCalledWith(false, SPLIT_MIN_WIDTH_PX - 1);
    resize().resize(SPLIT_MIN_WIDTH_PX);
    expect(r.onFitChange).toHaveBeenLastCalledWith(true, SPLIT_MIN_WIDTH_PX);
    const calls = r.onFitChange.mock.calls.length;
    resize().resize(0);
    resize().resize(SPLIT_MIN_WIDTH_PX);
    expect(r.onFitChange).toHaveBeenCalledTimes(calls);
  });

  test('sem ResizeObserver: nunca avisa (o app considera que cabe)', () => {
    vi.stubGlobal('ResizeObserver', undefined);
    const r = renderSplit();
    expect(r.onFitChange).not.toHaveBeenCalled();
    expect(separator()).toBeTruthy();
  });
});

describe('SplitPane: `minStart` (r39b, editor dividido: 640 no início, 960 no total)', () => {
  test('o início fica com `minStart`; os dois lados cabem a partir de `minStart` + 320', () => {
    const resize = withResizeObserver();
    const r = renderSplit({ ratio: 0.5, minStart: 640 });
    // 1024 px de área → 1000 úteis: 640 px no início = 64 %; 320 no fim = 68 %.
    resize().resize(1024);
    expect(separator().getAttribute('aria-valuemin')).toBe('64');
    expect(separator().getAttribute('aria-valuemax')).toBe('68');
    expect(separator().getAttribute('aria-valuenow')).toBe('64');
    expect(r.onFitChange).toHaveBeenLastCalledWith(true, 1024);
    resize().resize(959);
    expect(r.onFitChange).toHaveBeenLastCalledWith(false, 959);
    resize().resize(960);
    expect(r.onFitChange).toHaveBeenLastCalledWith(true, 960);
    // Com o divisor, 960 px não dão 640 + 320: o início fica com os 640 e o fim com o resto.
    const root = r.container.querySelector<HTMLElement>('.smd-split');
    const ratio = Number(root?.style.getPropertyValue('--smd-split-ratio'));
    expect(Math.round(ratio * (960 - 24))).toBe(640);
    key('Home');
    key('End');
    expect(r.onRatioChange).not.toHaveBeenCalled();
  });

  test('o mínimo novo com a mesma largura avisa de novo; sem `minStart`, os 900 px de sempre', () => {
    const resize = withResizeObserver();
    const r = renderSplit();
    resize().resize(930);
    expect(r.onFitChange).toHaveBeenLastCalledWith(true, 930);
    r.rerenderWith({ minStart: SPLIT_MIN_PANE_PX });
    expect(r.onFitChange).toHaveBeenCalledTimes(1);
    r.rerenderWith({ minStart: 640 });
    expect(r.onFitChange).toHaveBeenLastCalledWith(false, 930);
    r.rerenderWith({ minStart: SPLIT_MIN_PANE_PX });
    expect(r.onFitChange).toHaveBeenLastCalledWith(true, 930);
    expect(r.onFitChange).toHaveBeenCalledTimes(3);
  });
});

describe('SplitPane: teclado (←/→ 2 %, Shift 10 %, PageUp/PageDown 10 %, Home/End)', () => {
  test('cada tecla grava uma vez a partir do valor atual', () => {
    const r = renderSplit({ ratio: 0.5 });
    key('ArrowRight');
    key('ArrowLeft');
    key('ArrowRight', { shiftKey: true });
    key('ArrowLeft', { shiftKey: true });
    key('PageUp');
    key('PageDown');
    key('Home');
    key('End');
    expect(r.onRatioChange.mock.calls.map(([ratio]) => ratio)).toEqual([
      0.52, 0.48, 0.6, 0.4, 0.6, 0.4, 0.1, 0.9,
    ]);
  });

  test('Home/End param nos 320 px de cada lado; no limite, nada é gravado', () => {
    const resize = withResizeObserver();
    const r = renderSplit({ ratio: 0.5 });
    resize().resize(1024);
    key('Home');
    key('End');
    expect(r.onRatioChange.mock.calls.map(([ratio]) => ratio)).toEqual([0.32, 0.68]);
    r.onRatioChange.mockClear();
    r.rerenderWith({ ratio: 0.68 });
    key('End');
    key('ArrowRight');
    key('PageUp');
    expect(r.onRatioChange).not.toHaveBeenCalled();
    key('ArrowLeft');
    expect(r.onRatioChange).toHaveBeenLastCalledWith(0.66);
  });

  test('outras teclas seguem adiante (sem preventDefault)', () => {
    const r = renderSplit();
    expect(fireEvent.keyDown(separator(), { key: 'Tab' })).toBe(true);
    expect(fireEvent.keyDown(separator(), { key: 'ArrowRight' })).toBe(false);
    expect(r.onRatioChange).toHaveBeenCalledTimes(1);
  });
});

describe('SplitPane: ponteiro', () => {
  const down = (x: number) =>
    fireEvent.pointerDown(separator(), { clientX: x, pointerId: 7, button: 0, isPrimary: true });
  const move = (x: number) => fireEvent.pointerMove(separator(), { clientX: x, pointerId: 7 });
  const up = (x: number) => fireEvent.pointerUp(separator(), { clientX: x, pointerId: 7 });

  test('o arraste mostra ao vivo e grava UMA vez, ao soltar; o divisor fica focado', () => {
    layout();
    const r = renderSplit({ ratio: 0.5 });
    down(512);
    expect(document.activeElement).toBe(separator());
    move(562);
    move(612);
    expect(separator().getAttribute('aria-valuenow')).toBe('60');
    expect(r.container.querySelector('.smd-split')?.hasAttribute('data-dragging')).toBe(true);
    expect(r.onRatioChange).not.toHaveBeenCalled();
    up(612);
    expect(r.onRatioChange).toHaveBeenCalledTimes(1);
    expect(r.onRatioChange).toHaveBeenCalledWith(0.6);
    expect(r.container.querySelector('.smd-split')?.hasAttribute('data-dragging')).toBe(false);
  });

  test('o arraste para nos 320 px de cada lado', () => {
    layout();
    const r = renderSplit({ ratio: 0.5 });
    down(512);
    move(2000);
    expect(separator().getAttribute('aria-valuenow')).toBe('68');
    up(2000);
    expect(r.onRatioChange).toHaveBeenCalledWith(0.68);
  });

  test('Esc cancela o arraste: volta ao valor de antes e nada é gravado', () => {
    layout();
    const r = renderSplit({ ratio: 0.5 });
    down(512);
    move(700);
    expect(separator().getAttribute('aria-valuenow')).not.toBe('50');
    key('Escape');
    expect(separator().getAttribute('aria-valuenow')).toBe('50');
    up(700);
    expect(r.onRatioChange).not.toHaveBeenCalled();
  });

  test('clique sem arraste não grava; duplo clique volta a 50 %', () => {
    layout();
    const r = renderSplit({ ratio: 0.7 });
    down(712);
    move(713);
    up(714);
    expect(r.onRatioChange).not.toHaveBeenCalled();
    fireEvent.doubleClick(separator());
    expect(r.onRatioChange).toHaveBeenCalledWith(0.5);
    r.onRatioChange.mockClear();
    r.rerenderWith({ ratio: 0.5 });
    fireEvent.doubleClick(separator());
    expect(r.onRatioChange).not.toHaveBeenCalled();
  });

  test('outro botão ou outro ponteiro não arrasta', () => {
    layout();
    const r = renderSplit({ ratio: 0.5 });
    fireEvent.pointerDown(separator(), { clientX: 512, pointerId: 1, button: 2, isPrimary: true });
    fireEvent.pointerMove(separator(), { clientX: 700, pointerId: 1 });
    fireEvent.pointerUp(separator(), { clientX: 700, pointerId: 1 });
    down(512);
    fireEvent.pointerMove(separator(), { clientX: 700, pointerId: 9 });
    expect(separator().getAttribute('aria-valuenow')).toBe('50');
    fireEvent.pointerCancel(separator(), { pointerId: 7 });
    expect(r.onRatioChange).not.toHaveBeenCalled();
  });
});

describe('PreviewPane (design-r38 §1)', () => {
  function renderPane(props: Partial<PreviewPaneProps> = {}) {
    const onClose = vi.fn();
    const onFocusExit = vi.fn();
    const host = createRef<HTMLDivElement>();
    const view = (extra: Partial<PreviewPaneProps>) => (
      <PreviewPane
        name="nota.md"
        hostRef={host}
        busy={false}
        error={null}
        refused={0}
        closeKey="Mod-Shift-d"
        onClose={onClose}
        onFocusExit={onFocusExit}
        {...props}
        {...extra}
      />
    );
    const result = render(view({}));
    return {
      ...result,
      host,
      onClose,
      onFocusExit,
      rerenderWith: (e: Partial<PreviewPaneProps>) => result.rerender(view(e)),
    };
  }

  test('região "Prévia — nome", selo "Só leitura", "Fechar prévia" com o atalho', () => {
    const r = renderPane();
    const region = screen.getByRole('region', { name: 'Prévia — nota.md' });
    expect(region.querySelector('h2')?.textContent).toBe('Prévia — nota.md');
    expect(region.textContent).toContain(PREVIEW_PANE_TEXT.readOnly);
    const close = screen.getByRole('button', { name: 'Fechar prévia' });
    expect(close.getAttribute('aria-keyshortcuts')).toMatch(/^(Meta|Control)\+Shift\+D$/);
    expect(close.getAttribute('title')).toMatch(/^Fechar prévia \((⌘⇧D|Ctrl\+Shift\+D)\)$/);
    fireEvent.click(close);
    expect(r.onClose).toHaveBeenCalledTimes(1);
  });

  test('host: documento focável e nomeado, `aria-busy` ao renderizar, nunca escrito pelo React', () => {
    const r = renderPane();
    const host = screen.getByRole('document', { name: 'Conteúdo da prévia' });
    expect(r.host.current).toBe(host);
    expect(host.tabIndex).toBe(0);
    expect(host.classList.contains('smd-doc')).toBe(true);
    expect(host.hasAttribute('aria-busy')).toBe(false);
    expect(host.childNodes).toHaveLength(0);
    // O motor escreve no host (D-R38-07); o React não apaga o que ele pôs.
    const block = document.createElement('div');
    block.className = 'smd-preview-block';
    host.append(block);
    r.rerenderWith({ busy: true, name: 'outra.md' });
    expect(host.getAttribute('aria-busy')).toBe('true');
    expect(host.firstChild).toBe(block);
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('Prévia — outra.md');
  });

  test('status: falha (segura ou do pipeline), blocos recusados; vazio sem nada a dizer', () => {
    const r = renderPane();
    const status = screen.getByRole('status');
    expect(status.textContent).toBe('');
    r.rerenderWith({ refused: 1 });
    expect(status.textContent).toBe(
      '1 bloco não exibido na prévia: conteúdo recusado por segurança.',
    );
    r.rerenderWith({ refused: 3 });
    expect(status.textContent).toBe(
      '3 blocos não exibidos na prévia: conteúdo recusado por segurança.',
    );
    r.rerenderWith({ error: 'unsafe', refused: 0 });
    expect(status.textContent).toBe(
      'A prévia não pôde ser exibida: conteúdo recusado por segurança.',
    );
    r.rerenderWith({ error: 'failed' });
    expect(status.textContent).toBe('A prévia não pôde ser exibida.');
    expect(status.getAttribute('data-error')).toBe('failed');
    expect(screen.getByRole('status')).toBe(status);
  });

  test('o foco volta uma vez: ao sair do DOM com o foco dentro ou por "Fechar prévia"', () => {
    const first = renderPane();
    screen.getByRole('document', { name: 'Conteúdo da prévia' }).focus();
    first.unmount();
    expect(first.onFocusExit).toHaveBeenCalledTimes(1);

    const second = renderPane();
    second.unmount();
    expect(second.onFocusExit).not.toHaveBeenCalled();

    // "Fechar prévia" devolve o foco mesmo sem foco no botão (WebKit); a saída do DOM não repete.
    const third = renderPane();
    const close = screen.getByRole('button', { name: 'Fechar prévia' });
    fireEvent.click(close);
    expect(third.onFocusExit).toHaveBeenCalledTimes(1);
    close.focus();
    third.unmount();
    expect(third.onClose).toHaveBeenCalledTimes(1);
    expect(third.onFocusExit).toHaveBeenCalledTimes(1);
  });
});
