import type * as CodeMirrorView from '@codemirror/view';
import { createMarkdownExtensions, createMarkdownState } from '@simplemd/core';
import { cleanup, render, waitFor } from '@testing-library/react';
import { createRef, StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CodeMirrorEditor, Dialog, type CodeMirrorEditorHandle } from '../src';

const counts = vi.hoisted(() => ({ constructed: 0, destroyed: 0 }));

// Conta construções e destruições do EditorView sem mudar seu comportamento: as estáticas e
// facets são herdadas, então as extensões do core continuam funcionando.
vi.mock('@codemirror/view', async (importOriginal) => {
  const original = await importOriginal<typeof CodeMirrorView>();
  class CountingEditorView extends original.EditorView {
    constructor(config?: ConstructorParameters<typeof original.EditorView>[0]) {
      super(config);
      counts.constructed++;
    }
    override destroy(): void {
      counts.destroyed++;
      super.destroy();
    }
  }
  return { ...original, EditorView: CountingEditorView };
});

beforeEach(() => {
  counts.constructed = 0;
  counts.destroyed = 0;
});

afterEach(cleanup);

describe('<CodeMirrorEditor> cria o EditorView uma única vez (regra 5, AC-1.6)', () => {
  it('≥ 5 re-renderizações com props alteradas constroem o EditorView 1 vez; desmontar destrói 1 vez', () => {
    const view = render(
      <CodeMirrorEditor initialDoc="a" extensions={createMarkdownExtensions()} className="c0" />,
    );
    for (let i = 1; i <= 6; i++) {
      view.rerender(
        <CodeMirrorEditor
          initialDoc={`doc ${i}`}
          extensions={createMarkdownExtensions({ ariaLabel: `rótulo ${i}` })}
          onChange={() => {}}
          className={`c${i}`}
          data-testid={`editor-${i}`}
        />,
      );
    }
    expect(counts.constructed).toBe(1);
    expect(counts.destroyed).toBe(0);
    expect(view.container.querySelectorAll('.cm-editor')).toHaveLength(1);
    view.unmount();
    expect(counts.constructed).toBe(1);
    expect(counts.destroyed).toBe(1);
  });

  it('em StrictMode não vaza view: construções − destruições = 1', () => {
    const view = render(
      <StrictMode>
        <CodeMirrorEditor initialDoc="a" />
      </StrictMode>,
    );
    view.rerender(
      <StrictMode>
        <CodeMirrorEditor initialDoc="b" />
      </StrictMode>,
    );
    expect(counts.constructed - counts.destroyed).toBe(1);
    expect(view.container.querySelectorAll('.cm-editor')).toHaveLength(1);
    view.unmount();
    expect(counts.constructed - counts.destroyed).toBe(0);
  });
});

describe('<CodeMirrorEditor> comunica por dispatch, não por props (AC-1.7)', () => {
  it('mudar initialDoc depois da montagem não altera o documento', () => {
    const ref = createRef<CodeMirrorEditorHandle>();
    const view = render(<CodeMirrorEditor ref={ref} initialDoc="original" />);
    view.rerender(<CodeMirrorEditor ref={ref} initialDoc="trocado" />);
    expect(ref.current?.getText()).toBe('original');
  });

  it('dispatch pelo handle muda o documento e dispara onChange exatamente 1 vez', () => {
    const ref = createRef<CodeMirrorEditorHandle>();
    const onChange = vi.fn();
    render(<CodeMirrorEditor ref={ref} initialDoc="abc" onChange={onChange} />);
    ref.current?.dispatch({ changes: { from: 3, insert: 'd' } });
    expect(ref.current?.getText()).toBe('abcd');
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0]?.[0].docChanged).toBe(true);
  });

  it('usa sempre o onChange mais recente sem recriar o view', () => {
    const ref = createRef<CodeMirrorEditorHandle>();
    const first = vi.fn();
    const second = vi.fn();
    const view = render(<CodeMirrorEditor ref={ref} initialDoc="" onChange={first} />);
    view.rerender(<CodeMirrorEditor ref={ref} initialDoc="" onChange={second} />);
    ref.current?.dispatch({ changes: { from: 0, insert: 'x' } });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    expect(counts.constructed).toBe(1);
  });

  it('uma transação só de seleção não dispara onChange', () => {
    const ref = createRef<CodeMirrorEditorHandle>();
    const onChange = vi.fn();
    render(<CodeMirrorEditor ref={ref} initialDoc="abc" onChange={onChange} />);
    ref.current?.dispatch({ selection: { anchor: 1 } });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('setState troca o estado sem disparar onChange; dispatch posterior volta a disparar', () => {
    const ref = createRef<CodeMirrorEditorHandle>();
    const onChange = vi.fn();
    render(<CodeMirrorEditor ref={ref} initialDoc="aba A" onChange={onChange} />);
    ref.current?.setState(createMarkdownState('aba B'));
    expect(ref.current?.getText()).toBe('aba B');
    expect(onChange).not.toHaveBeenCalled();
    ref.current?.dispatch({ changes: { from: 5, insert: '!' } });
    expect(ref.current?.getText()).toBe('aba B!');
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(counts.constructed).toBe(1);
  });

  it('initialState tem precedência sobre initialDoc', () => {
    const ref = createRef<CodeMirrorEditorHandle>();
    render(
      <CodeMirrorEditor
        ref={ref}
        initialDoc="ignorado"
        initialState={createMarkdownState('estado')}
      />,
    );
    expect(ref.current?.getText()).toBe('estado');
    expect(ref.current?.view.contentDOM.getAttribute('aria-label')).toBe('Editor de markdown');
  });
});

describe('<CodeMirrorEditor> focus() e a seleção do DOM (AC-R11-3.4)', () => {
  /** Editor montado com a seleção do DOM dentro do conteúdo; registra a ordem das chamadas. */
  function setupFocus(): { ref: CodeMirrorEditorHandle; calls: string[] } {
    const ref = createRef<CodeMirrorEditorHandle>();
    render(<CodeMirrorEditor ref={ref} initialDoc={'linha 1\nlinha 2\nlinha 3'} />);
    const view = ref.current!.view;
    const text = view.contentDOM.querySelectorAll('.cm-line')[2]!.firstChild!;
    document.getSelection()!.collapse(text, 3);
    const calls: string[] = [];
    vi.spyOn(Selection.prototype, 'removeAllRanges').mockImplementation(() => {
      calls.push('removeAllRanges');
    });
    vi.spyOn(view, 'focus').mockImplementation(() => calls.push('view.focus'));
    return { ref: ref.current!, calls };
  }

  afterEach(() => vi.restoreAllMocks());

  it('sem foco: limpa a seleção do DOM dentro do conteúdo antes do view.focus()', () => {
    const { ref, calls } = setupFocus();
    ref.focus();
    expect(calls).toEqual(['removeAllRanges', 'view.focus']);
  });

  it('com foco: não mexe na seleção do DOM', () => {
    const { ref, calls } = setupFocus();
    vi.spyOn(Document.prototype, 'activeElement', 'get').mockReturnValue(ref.view.contentDOM);
    ref.focus();
    expect(calls).toEqual(['view.focus']);
  });

  it('janela inativa com o conteúdo ainda ativo: não mexe na seleção do DOM', () => {
    const { ref, calls } = setupFocus();
    vi.spyOn(Document.prototype, 'activeElement', 'get').mockReturnValue(ref.view.contentDOM);
    vi.spyOn(ref.view, 'hasFocus', 'get').mockReturnValue(false);
    ref.focus();
    expect(calls).toEqual(['view.focus']);
  });

  it('sem foco e seleção fora do conteúdo: não mexe na seleção', () => {
    const { ref, calls } = setupFocus();
    const outside = document.body.appendChild(document.createElement('p'));
    outside.textContent = 'fora';
    document.getSelection()!.collapse(outside.firstChild!, 2);
    ref.focus();
    expect(calls).toEqual(['view.focus']);
  });
});

describe('<CodeMirrorEditor> um ouvinte por módulo, roteado pelo view (r39a, D-R39-07)', () => {
  it('o estado de A levado ao editor B só chama o onChange de B; de volta a A, só o de A', () => {
    const a = createRef<CodeMirrorEditorHandle>();
    const b = createRef<CodeMirrorEditorHandle>();
    const onA = vi.fn();
    const onB = vi.fn();
    render(<CodeMirrorEditor ref={a} initialDoc="nota A" onChange={onA} />);
    render(<CodeMirrorEditor ref={b} initialDoc="nota B" onChange={onB} />);
    b.current!.setState(a.current!.view.state);
    b.current!.dispatch({ changes: { from: 6, insert: '!' } });
    expect(onB).toHaveBeenCalledTimes(1);
    expect(onB.mock.calls[0]?.[0].view).toBe(b.current!.view);
    expect(onA).not.toHaveBeenCalled();
    a.current!.setState(b.current!.view.state);
    a.current!.dispatch({ changes: { from: 0, insert: '>' } });
    expect(a.current!.getText()).toBe('>nota A!');
    expect(onA).toHaveBeenCalledTimes(1);
    expect(onB).toHaveBeenCalledTimes(1);
  });

  it('o editor desmontado nunca é chamado, com o estado dele vivo no outro (junção)', () => {
    const a = createRef<CodeMirrorEditorHandle>();
    const b = createRef<CodeMirrorEditorHandle>();
    const onA = vi.fn();
    const onB = vi.fn();
    render(<CodeMirrorEditor ref={a} initialDoc="nota A" onChange={onA} />);
    const right = render(<CodeMirrorEditor ref={b} initialDoc="nota B" onChange={onB} />);
    const left = b.current!.view.state;
    right.unmount();
    a.current!.setState(left);
    a.current!.dispatch({ changes: { from: 0, insert: 'x' } });
    expect(onA).toHaveBeenCalledTimes(1);
    expect(onB).not.toHaveBeenCalled();
    expect(counts.constructed).toBe(2);
  });
});

describe('<CodeMirrorEditor> foco devolvido sem rolar (R38B-FOCO-ROLAGEM)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('focus() no conteúdo sem opções, como a devolução do foco, vai com preventScroll', () => {
    const native = vi.spyOn(HTMLElement.prototype, 'focus');
    const ref = createRef<CodeMirrorEditorHandle>();
    render(<CodeMirrorEditor ref={ref} initialDoc="a" />);
    const content = ref.current!.view.contentDOM;
    content.focus();
    expect(native).toHaveBeenCalledTimes(1);
    expect(native).toHaveBeenCalledWith({ preventScroll: true });
    expect(native.mock.contexts[0]).toBe(content);
    expect(document.activeElement).toBe(content);
  });

  it('sem foco, tira a seleção velha do conteúdo antes do foco de fora (AC-R11-3.4)', () => {
    const calls: string[] = [];
    vi.spyOn(HTMLElement.prototype, 'focus').mockImplementation((options) => {
      calls.push(`focus ${JSON.stringify(options)}`);
    });
    const ref = createRef<CodeMirrorEditorHandle>();
    render(<CodeMirrorEditor ref={ref} initialDoc={'linha 1\nlinha 2'} />);
    const content = ref.current!.view.contentDOM;
    document.getSelection()!.collapse(content.querySelectorAll('.cm-line')[1]!.firstChild!, 3);
    vi.spyOn(Selection.prototype, 'removeAllRanges').mockImplementation(() => {
      calls.push('removeAllRanges');
    });
    content.focus({ preventScroll: false });
    expect(calls).toEqual(['removeAllRanges', 'focus {"preventScroll":true}']);
  });

  it('fechar um diálogo devolve o foco ao conteúdo com preventScroll', async () => {
    // Espião antes da montagem: o `focus` do conteúdo chama o nativo guardado nela.
    const native = vi.spyOn(HTMLElement.prototype, 'focus');
    const ref = createRef<CodeMirrorEditorHandle>();
    const shell = (open: boolean) => (
      <>
        <CodeMirrorEditor ref={ref} initialDoc={'linha 1\nlinha 2\nlinha 3'} />
        <Dialog open={open} onClose={() => {}} title="Configurações" footer={null}>
          <button type="button">Tema</button>
        </Dialog>
      </>
    );
    const view = render(shell(false));
    const content = ref.current!.view.contentDOM;
    ref.current!.focus();
    expect(document.activeElement).toBe(content);
    view.rerender(shell(true));
    await waitFor(() => expect(document.activeElement).not.toBe(content));
    native.mockClear();
    view.rerender(shell(false));
    await waitFor(() => expect(document.activeElement).toBe(content));
    const toContent = native.mock.calls.filter((_, i) => native.mock.contexts[i] === content);
    expect(toContent).toEqual([[{ preventScroll: true }]]);
  });
});
