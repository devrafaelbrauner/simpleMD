// @vitest-environment jsdom
import { undo, undoDepth } from '@codemirror/commands';
import { EditorState } from '@codemirror/state';
import { EditorView, hasHoverTooltips, keymap } from '@codemirror/view';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  appPlatformFacet,
  createMarkdownExtensions,
  createMarkdownState,
  EDITOR_MODE_ATTRIBUTE,
  EditorHost,
  isLivePreview,
  LIVE_PREVIEW_TEXT,
  linkOpenerFacet,
  observeLivePreview,
  setLivePreview,
  toggleLivePreviewAnnounced,
  type EditorMode,
  type LinkTarget,
} from '../src';
import { LINK_TIP_DELAY_MS } from '../src/links';
import { linkReferencesField } from '../src/live-preview/references';
import fixture from './fixtures/live-preview.md?raw';
import { fullyParsed } from './helpers/live-preview';

/**
 * r27a (D-R27-01/D-R27-04): a renderização do live preview mora num compartimento do próprio
 * estado. Alternar é um `reconfigure`: o mesmo `EditorView`, documento, seleção e desfazer intactos;
 * gestos e teclas de link, tarefa e "interagir" valem nos dois modos; o modo é do estado (o
 * `refresh` do `EditorHost` não o muda).
 */
const views: EditorView[] = [];

afterEach(() => {
  while (views.length) views.pop()?.destroy();
  document.body.innerHTML = '';
  vi.useRealTimers();
  vi.restoreAllMocks();
});

let constructions = 0;
class CountingView extends EditorView {
  constructor(config: ConstructorParameters<typeof EditorView>[0]) {
    super(config);
    constructions++;
  }
}

function mount(state: EditorState): EditorView {
  const parent = document.body.appendChild(document.createElement('div'));
  const view = new CountingView({ state, parent });
  views.push(view);
  return fullyParsed(view);
}

const firstLine = (view: EditorView) => view.contentDOM.querySelector('.cm-line')!;
const rendered = (view: EditorView) => ({
  h1: firstLine(view).className.includes('cm-md-h1'),
  table: view.contentDOM.querySelector('table.cm-md-table') !== null,
  band: view.dom.querySelector('.cm-md-band-layer') !== null,
  mode: view.dom.getAttribute(EDITOR_MODE_ATTRIBUTE),
});
const keys = (state: EditorState) =>
  state
    .facet(keymap)
    .flat()
    .map((binding) => binding.key)
    .filter((key): key is string => key !== undefined)
    .sort();

describe('r27a: modo do estado', () => {
  test('prévia por padrão; `livePreview: false` cria no modo fonte; sem o compartimento conta como prévia', () => {
    expect(isLivePreview(createMarkdownState('x'))).toBe(true);
    expect(isLivePreview(createMarkdownState('x', { livePreview: false }))).toBe(false);
    expect(isLivePreview(EditorState.create({ doc: 'x' }))).toBe(true);
    const source = mount(createMarkdownState(fixture, { livePreview: false }));
    expect(rendered(source)).toEqual({ h1: false, table: false, band: false, mode: 'source' });
    expect(firstLine(source).textContent?.startsWith('# ')).toBe(true);
    const live = mount(createMarkdownState(fixture));
    expect(rendered(live)).toEqual({ h1: true, table: true, band: true, mode: 'live' });
  });

  test('alternar só reconfigura: 1 EditorView, doc/seleção/desfazer intactos, renderização sai e volta', () => {
    const before = constructions;
    const view = mount(createMarkdownState(fixture));
    view.dispatch({ changes: { from: view.state.doc.length, insert: 'fim\n' } });
    view.dispatch({ selection: { anchor: 3, head: 9 } });
    const doc = view.state.doc.toString();
    const selection = view.state.selection;
    const depth = undoDepth(view.state);
    expect(depth).toBe(1);

    view.dispatch({ effects: setLivePreview(false) });
    expect(isLivePreview(view.state)).toBe(false);
    expect(rendered(view)).toEqual({ h1: false, table: false, band: false, mode: 'source' });
    expect(view.state.doc.toString()).toBe(doc);
    expect(view.state.selection.eq(selection)).toBe(true);
    expect(undoDepth(view.state)).toBe(depth);

    view.dispatch({ effects: setLivePreview(true) });
    fullyParsed(view);
    expect(isLivePreview(view.state)).toBe(true);
    expect(rendered(view)).toEqual({ h1: true, table: true, band: true, mode: 'live' });
    expect(view.state.selection.eq(selection)).toBe(true);
    expect(undoDepth(view.state)).toBe(depth);

    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe(fixture);
    expect(constructions - before).toBe(1);
  });

  test('toggleLivePreviewAnnounced: alterna, anuncia e não entra no desfazer', () => {
    const view = mount(createMarkdownState('# Nota\n'));
    const announced = () => view.dom.querySelector('.cm-announced')?.textContent;
    expect(toggleLivePreviewAnnounced(view)).toBe('source');
    expect(announced()).toBe(LIVE_PREVIEW_TEXT.announceSource);
    expect(toggleLivePreviewAnnounced(view)).toBe('live');
    expect(announced()).toBe(LIVE_PREVIEW_TEXT.announceLive);
    expect(undoDepth(view.state)).toBe(0);
    expect(undo(view)).toBe(false);
    expect(view.state.doc.toString()).toBe('# Nota\n');
  });

  test('modo fonte mantém as teclas (⌥↩, ⌘L, ⌘⇧↩) e as definições de link (D-R27-04)', () => {
    const live = createMarkdownState(fixture);
    const source = createMarkdownState(fixture, { livePreview: false });
    expect(keys(source)).toEqual(keys(live));
    expect(keys(source)).toEqual(expect.arrayContaining(['Alt-Enter', 'Mod-l', 'Mod-Shift-Enter']));
    expect(source.field(linkReferencesField, false)).toBeDefined();
  });

  test('o modo é do estado: contribuições novas do EditorHost (refresh) não o mudam', () => {
    const host = new EditorHost();
    const source = host.createState('# a\n', { livePreview: false, notePath: 'a.md' });
    const live = host.createState('# b\n', { notePath: 'b.md' });
    host.update({ pluginExtensions: [] });
    const refreshed = [host.refresh(source), host.refresh(live)];
    expect(refreshed.map((state) => state !== source && state !== live)).toEqual([true, true]);
    expect(refreshed.map(isLivePreview)).toEqual([false, true]);
  });

  test('observeLivePreview avisa ao montar, ao alternar e no setState; nunca em transação sem mudança de modo', () => {
    const seen: EditorMode[] = [];
    const observer = observeLivePreview((mode) => seen.push(mode));
    const state = (live: boolean) =>
      EditorState.create({
        doc: 'x',
        extensions: [createMarkdownExtensions({ livePreview: live }), observer],
      });
    const view = mount(state(true));
    view.dispatch({ changes: { from: 1, insert: 'y' } });
    view.dispatch({ selection: { anchor: 0 } });
    expect(seen).toEqual(['live']);
    view.dispatch({ effects: setLivePreview(false) });
    view.dispatch({ effects: setLivePreview(false) });
    expect(seen).toEqual(['live', 'source']);
    view.setState(state(true));
    expect(seen).toEqual(['live', 'source', 'live']);
  });
});

describe('r27b (NB-2 da r27a): gesto e dica de link no modo fonte (D-R27-04)', () => {
  const URL_ = 'https://exemplo.org/a';
  const DOC = `Veja [site](${URL_}) agora.\n`;

  /**
   * Editor no modo fonte (criado assim ou alternado depois de montar), plataforma `other` e um
   * abridor espião. No modo fonte não há span `.cm-md-link`: o gesto acha o link pelas coordenadas
   * do ponteiro. O jsdom não tem layout, então a geometria é um dublê que põe o ponteiro em `site`.
   */
  function sourceEditor(start: 'created' | 'toggled') {
    const opened: LinkTarget[] = [];
    const view = mount(
      EditorState.create({
        doc: DOC,
        extensions: [
          createMarkdownExtensions({ livePreview: start === 'toggled' }),
          appPlatformFacet.of('other'),
          linkOpenerFacet.of({ open: (target) => void opened.push(target), noLink: () => {} }),
        ],
      }),
    );
    if (start === 'toggled') view.dispatch({ effects: setLivePreview(false) });
    expect(isLivePreview(view.state)).toBe(false);
    expect(view.contentDOM.querySelector('.cm-md-link')).toBeNull();
    vi.spyOn(view, 'posAtCoords').mockReturnValue(DOC.indexOf('site'));
    vi.spyOn(view, 'coordsAtPos').mockReturnValue({ left: 0, right: 0, top: 0, bottom: 0 });
    return { view, opened, line: firstLine(view) };
  }

  test.each(['created', 'toggled'] as const)(
    'Ctrl-clique no link cru abre o destino uma vez e cancela o padrão (modo fonte %s)',
    (start) => {
      const { view, opened, line } = sourceEditor(start);
      const click = new MouseEvent('mousedown', {
        bubbles: true,
        cancelable: true,
        button: 0,
        ctrlKey: true,
      });
      line.dispatchEvent(click);
      expect(click.defaultPrevented).toBe(true);
      expect(opened).toEqual([{ kind: 'external', url: URL_ }]);
      expect(view.state.selection.ranges).toHaveLength(1);
      // ⌘ (Meta) fora do macOS não é o gesto.
      line.dispatchEvent(
        new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, metaKey: true }),
      );
      expect(opened).toHaveLength(1);
    },
  );

  test('dica do link depois de 500 ms, com o destino e "Ctrl-clique para abrir"', () => {
    // Só o temporizador e o relógio: o resto falso trava o `hoverTooltip` no jsdom.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const { view, line } = sourceEditor('toggled');
    line.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 0, clientY: 0 }));
    vi.advanceTimersByTime(LINK_TIP_DELAY_MS - 100);
    expect(hasHoverTooltips(view.state)).toBe(false);
    vi.advanceTimersByTime(200);
    expect(hasHoverTooltips(view.state)).toBe(true);
    const tip = view.dom.querySelector('.cm-md-link-tip');
    expect(tip?.getAttribute('role')).toBe('tooltip');
    expect(tip?.textContent).toBe(`${URL_} · Ctrl-clique para abrir`);
  });

  test('`clickAddsSelectionRange` do gesto vale nos dois modos', () => {
    const live = createMarkdownState(DOC).facet(EditorView.clickAddsSelectionRange);
    const source = createMarkdownState(DOC, { livePreview: false }).facet(
      EditorView.clickAddsSelectionRange,
    );
    expect(source.length).toBeGreaterThan(0);
    expect(source).toEqual(live);
  });
});
