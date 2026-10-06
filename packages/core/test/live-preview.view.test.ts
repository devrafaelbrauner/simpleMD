// @vitest-environment jsdom
import { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMarkdownState, setEditorFocus } from '../src';
import { editorFocusField } from '../src/live-preview/focus';
import fixture from './fixtures/live-preview.md?raw';

const views: EditorView[] = [];

function mount(doc = fixture): EditorView {
  const parent = document.body.appendChild(document.createElement('div'));
  const view = new EditorView({ state: createMarkdownState(doc), parent });
  views.push(view);
  return view;
}

afterEach(() => {
  while (views.length) views.pop()?.destroy();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

const firstLine = (view: EditorView) => view.contentDOM.querySelector('.cm-line')!;

describe('live preview num EditorView real (jsdom)', () => {
  it('carga sem foco: a linha do h1 não começa com "#" e tem cm-md-h1; existe uma <table>', () => {
    const view = mount();
    expect(view.state.field(editorFocusField)).toBe(false);
    expect(firstLine(view).className).toContain('cm-md-h1');
    expect(firstLine(view).textContent?.startsWith('#')).toBe(false);
    expect(view.contentDOM.querySelector('table.cm-md-table')).not.toBeNull();
    expect(view.contentDOM.querySelectorAll('.cm-md-bullet[aria-hidden="true"]').length).toBe(4);
  });

  it('com foco e cursor no h1, "# " aparece (revelação)', () => {
    const view = mount();
    view.dispatch({ selection: { anchor: 3 }, effects: setEditorFocus.of(true) });
    expect(firstLine(view).textContent?.startsWith('# ')).toBe(true);
  });

  it('o link renderizado é um <span> inerte: sem <a>, sem href, clique não abre nada', () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    const view = mount();
    const link = view.contentDOM.querySelector('.cm-md-link') as HTMLElement;
    expect(link.tagName).toBe('SPAN');
    expect(link.textContent).toBe('site do CodeMirror');
    expect(view.contentDOM.querySelector('a, [href]')).toBeNull();
    link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(open).not.toHaveBeenCalled();
  });

  it('o efeito de foco entra no estado pelo focusChangeEffect', () => {
    const view = mount();
    const [effect] = view.state
      .facet(EditorView.focusChangeEffect)
      .map((get) => get(view.state, true));
    expect(effect?.is(setEditorFocus)).toBe(true);
    expect(effect?.value).toBe(true);
  });

  it('setState num editor focado sincroniza o foco do novo estado (troca de aba)', async () => {
    const view = mount();
    vi.spyOn(view, 'hasFocus', 'get').mockReturnValue(true);
    view.setState(createMarkdownState('# Outra aba'));
    expect(view.state.field(editorFocusField)).toBe(false);
    await Promise.resolve();
    expect(view.state.field(editorFocusField)).toBe(true);
  });
});
