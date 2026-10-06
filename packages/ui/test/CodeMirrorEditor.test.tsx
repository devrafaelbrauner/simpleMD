import type * as CodeMirrorView from '@codemirror/view';
import { createMarkdownExtensions, createMarkdownState } from '@simplemd/core';
import { cleanup, render } from '@testing-library/react';
import { createRef, StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CodeMirrorEditor, type CodeMirrorEditorHandle } from '../src';

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
