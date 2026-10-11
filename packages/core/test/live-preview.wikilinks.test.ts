// @vitest-environment jsdom
import { EditorState, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, test } from 'vitest';
import {
  appPlatformFacet,
  createMarkdownExtensions,
  createNoteNameIndex,
  linkAt,
  linkOpenerFacet,
  noteContext,
  openLinkAtCursor,
  redecorate,
  resolveWikilink,
  setEditorFocus,
  wikilinkIndexFacet,
  type LinkOpener,
  type LinkTarget,
  type WikilinkIndex,
} from '../src';
import { renderExportBody } from '../src/export';
import { wikilinkTipParts } from '../src/live-preview/wikilinks';
import { decorate, fullyParsed, type FlatDeco } from './helpers/live-preview';

/** Índice falso com versão e assinantes (o app usa o `LinksIndex`). */
function fakeIndex(paths: string[]): WikilinkIndex & { set(paths: string[]): void } {
  let notes = createNoteNameIndex(paths);
  let version = 1;
  const listeners = new Set<() => void>();
  return {
    resolve: (target, from) => resolveWikilink(target, from, notes),
    get version() {
      return version;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set(next) {
      notes = createNoteNameIndex(next);
      version++;
      for (const listener of listeners) listener();
    },
  };
}

const NOTES = ['receitas/Bolo.md', 'a/Nota.md', 'b/Nota.md', 'diario/hoje.md'];

function state(doc: string, extensions: Extension[] = [], anchor = doc.length): EditorState {
  return EditorState.create({
    doc,
    selection: { anchor },
    extensions: [
      createMarkdownExtensions(),
      noteContext.of({ path: 'diario/hoje.md' }),
      ...extensions,
    ],
  }).update({ effects: setEditorFocus.of(true) }).state;
}

const views: EditorView[] = [];
afterEach(() => {
  while (views.length) views.pop()?.destroy();
  document.body.innerHTML = '';
});

function mount(doc: string, extensions: Extension[] = []): EditorView {
  const view = new EditorView({
    state: state(doc, extensions),
    parent: document.body.appendChild(document.createElement('div')),
  });
  views.push(view);
  return fullyParsed(view);
}

const marks = (decos: FlatDeco[]) => decos.filter((d) => d.kind === 'mark');

describe('live preview de wikilinks (R-I2.2; DESIGN §R7.6.4)', () => {
  test('existente/inexistente: rótulo, classes, colchetes escondidos, título como " › "', () => {
    const doc = 'Veja [[Bolo#Cobertura]] e [[Nova ideia]] e [[Bolo|a receita]].\n\nfim';
    const s = state(doc, [wikilinkIndexFacet.of(fakeIndex(NOTES))]);
    const { inline } = decorate(s);
    const m = marks(inline);
    expect(m.map((d) => [doc.slice(d.from, d.to), d.class])).toEqual([
      ['Bolo#Cobertura', 'cm-md-link cm-md-wikilink'],
      ['Nova ideia', 'cm-md-link cm-md-wikilink cm-md-wikilink-missing'],
      ['a receita', 'cm-md-link cm-md-wikilink'],
    ]);
    const hidden = inline.filter((d) => d.kind === 'replace').map((d) => doc.slice(d.from, d.to));
    expect(hidden).toEqual(['[[', ']]', '[[', ']]', '[[Bolo|', ']]']);
    expect(inline.filter((d) => d.kind === 'widget')).toHaveLength(1);
    expect(s.doc.toString()).toBe(doc);
  });

  test('DOM: role=link, data-testid, data-resolved e nome STR-147; sem href nem title', () => {
    const doc = '[[Bolo#Cobertura]] [[Nova ideia]] [[Nota]] [[#Local]]\n\nfim';
    const view = mount(doc, [wikilinkIndexFacet.of(fakeIndex(NOTES))]);
    const spans = [...view.contentDOM.querySelectorAll('[data-testid="cm-wikilink"]')];
    expect(
      spans.map((s) => [
        s.textContent,
        s.getAttribute('data-resolved'),
        s.getAttribute('aria-label'),
      ]),
    ).toEqual([
      ['Bolo › Cobertura', 'true', 'Bolo › Cobertura (nota: receitas/Bolo.md › Cobertura)'],
      ['Nova ideia', 'false', 'Nova ideia (nota inexistente)'],
      ['Nota', 'true', 'Nota (nota: a/Nota.md)'],
      ['Local', 'true', 'Local (nota: diario/hoje.md › Local)'],
    ]);
    for (const span of spans) {
      expect(span.getAttribute('role')).toBe('link');
      expect(span.hasAttribute('title')).toBe(false);
    }
    expect(view.contentDOM.querySelector('a, [href]')).toBeNull();
  });

  test('revelação: cursor dentro mostra o cru; `![[x]]` e código ficam crus', () => {
    const doc = 'x [[Bolo]] y\n\n![[Bolo]] `[[Bolo]]`';
    const inside = state(doc, [wikilinkIndexFacet.of(fakeIndex(NOTES))], 5);
    expect(marks(decorate(inside).inline).filter((d) => d.class?.includes('wikilink'))).toEqual([]);
    const outside = state(doc, [wikilinkIndexFacet.of(fakeIndex(NOTES))], 0);
    expect(
      marks(decorate(outside).inline).filter((d) => d.class?.includes('wikilink')),
    ).toHaveLength(1);
  });

  test('sem índice: inexistente (caminho de criação pela regra R-I2.5)', () => {
    const doc = '[[Bolo]]\n\nfim';
    expect(marks(decorate(state(doc)).inline)[0]?.class).toContain('cm-md-wikilink-missing');
  });

  test('efeito genérico `redecorate`: o conjunto de notas muda → o viewport redecora sem mudar texto', async () => {
    const index = fakeIndex(['receitas/Bolo.md']);
    const view = mount('[[Nova ideia]]\n\nfim', [wikilinkIndexFacet.of(index)]);
    const span = () => view.contentDOM.querySelector('[data-testid="cm-wikilink"]');
    expect(span()?.getAttribute('data-resolved')).toBe('false');
    index.set(['receitas/Bolo.md', 'diario/Nova ideia.md']);
    await Promise.resolve();
    expect(span()?.getAttribute('data-resolved')).toBe('true');
    expect(view.state.doc.toString()).toBe('[[Nova ideia]]\n\nfim');
    // O efeito também vale sozinho (contrato genérico do driver em linha).
    index.set(['receitas/Bolo.md']);
    view.dispatch({ effects: redecorate.of(null) });
    expect(span()?.getAttribute('data-resolved')).toBe('false');
  });
});

describe('abrir: linkAt, ⌘/Ctrl-clique e Alt-Enter (R-I2.4)', () => {
  test('linkAt devolve o destino `wikilink` com alvo, título e a nota de origem', () => {
    const doc = 'a [[Bolo#Cobertura|apelido]] b';
    const info = linkAt(state(doc), 10);
    expect(info?.target).toEqual({
      kind: 'wikilink',
      target: 'Bolo',
      heading: 'Cobertura',
      fromPath: 'diario/hoje.md',
    });
    expect(doc.slice(info?.textFrom, info?.textTo)).toBe('apelido');
  });

  test('"Abrir link sob o cursor" chama o serviço uma vez com o wikilink', () => {
    const opened: LinkTarget[] = [];
    const opener: LinkOpener = { open: (target) => void opened.push(target), noLink: () => {} };
    const view = mount('x [[Nova ideia]]', [linkOpenerFacet.of(opener)]);
    view.dispatch({ selection: { anchor: 5 } });
    expect(openLinkAtCursor(view)).toBe(true);
    expect(opened).toEqual([
      { kind: 'wikilink', target: 'Nova ideia', heading: null, fromPath: 'diario/hoje.md' },
    ]);
  });

  test('⌘-clique (mac) no span abre uma vez e não soma cursor', () => {
    const opened: LinkTarget[] = [];
    const opener: LinkOpener = { open: (target) => void opened.push(target), noLink: () => {} };
    const view = mount('[[Bolo]]\n\nfim', [
      linkOpenerFacet.of(opener),
      appPlatformFacet.of('mac'),
      wikilinkIndexFacet.of(fakeIndex(NOTES)),
    ]);
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    const span = view.contentDOM.querySelector('[data-testid="cm-wikilink"]') as HTMLElement;
    const event = new MouseEvent('mousedown', {
      bubbles: true,
      cancelable: true,
      metaKey: true,
      button: 0,
    });
    span.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(opened).toHaveLength(1);
    expect(view.state.selection.ranges).toHaveLength(1);
  });
});

describe('dica W1 (STR-148)', () => {
  const s = state('x', [
    wikilinkIndexFacet.of(
      fakeIndex(['receitas/Bolo.md', 'a/N.md', 'b/N.md', 'c/N.md', 'd/N.md', 'e/N.md']),
    ),
  ]);
  const text = (target: string, mac = true) =>
    wikilinkTipParts(s, target, mac)
      .map((p) => p.text)
      .join('');

  test('existente, ambígua (até 3 + total) e inexistente; Ctrl-clique fora do macOS', () => {
    expect(text('Bolo')).toBe('receitas/Bolo.md · ⌘-clique para abrir');
    expect(text('Bolo', false)).toBe('receitas/Bolo.md · Ctrl-clique para abrir');
    expect(text('N')).toBe('Abre a/N.md. Outras notas com este nome: b/N.md, c/N.md, d/N.md (+1)');
    expect(text('Nova ideia')).toBe('Nota inexistente. ⌘-clique cria “diario/Nova ideia.md”.');
    expect(text('Nova ideia', false)).toBe(
      'Nota inexistente. Ctrl-clique cria “diario/Nova ideia.md”.',
    );
    const ambiguousTwo = state('x', [wikilinkIndexFacet.of(fakeIndex(['a/M.md', 'b/M.md']))]);
    expect(
      wikilinkTipParts(ambiguousTwo, 'M', true)
        .map((p) => p.text)
        .join(''),
    ).toBe('Abre a/M.md. Outras notas com este nome: b/M.md');
    const noNote = EditorState.create({ doc: 'x', extensions: [createMarkdownExtensions()] });
    expect(wikilinkTipParts(noNote, '', true)).toEqual([
      { kind: 'text', text: 'Nota inexistente.' },
    ]);
  });

  test('CR-S2-03: nome que o clique recusaria → a recusa do app na dica, nunca "cria"', () => {
    const refusing = state('x', [
      wikilinkIndexFacet.of({
        resolve: () => ({
          kind: 'missing',
          createPath: '',
          refused: 'Nome de nota inválido: “CON” — x.',
        }),
        version: 1,
        subscribe: () => () => {},
      }),
    ]);
    expect(wikilinkTipParts(refusing, 'CON', true)).toEqual([
      { kind: 'text', text: 'Nota inexistente. Nome de nota inválido: “CON” — x.' },
    ]);
  });

  test('CR-S2-02: bidi/largura zero aparecem codificados na dica e no nome acessível', () => {
    const bidi = state('[[abc\u202Edm]]\n\nfim', [
      wikilinkIndexFacet.of(fakeIndex(['abc\u202Edm.md', 'z/abc\u202Edm.md', 'k/n\u200Bx.md'])),
    ]);
    const tip = wikilinkTipParts(bidi, 'abc\u202Edm', true)
      .map((p) => p.text)
      .join('');
    expect(tip).toBe('Abre abc%E2%80%AEdm.md. Outras notas com este nome: z/abc%E2%80%AEdm.md');
    expect(tip).not.toMatch(/[\u202E\u200B]/u);
    const missing = wikilinkTipParts(s, 'n\u200Bova', true)
      .map((p) => p.text)
      .join('');
    expect(missing).toBe('Nota inexistente. ⌘-clique cria “diario/n%E2%80%8Bova.md”.');
    const view = mount('[[abc\u202Edm]]\n\nfim', [
      wikilinkIndexFacet.of(fakeIndex(['abc\u202Edm.md'])),
    ]);
    expect(
      view.contentDOM.querySelector('[data-testid="cm-wikilink"]')?.getAttribute('aria-label'),
    ).toBe('abc%E2%80%AEdm (nota: abc%E2%80%AEdm.md)');
  });
});

describe('AC-EX.3 exportação de wikilinks', () => {
  const images = { notePath: 'diario/hoje.md', map: new Map() };
  const exists = { exists: (target: string) => ['bolo', ''].includes(target.toLowerCase()) };

  test('texto estilizado (apelido, alvo, alvo › Título), sem href e sem colchetes; inexistente com a classe', async () => {
    const doc =
      '[[Bolo|a receita]] [[Bolo]] [[Bolo#Cobertura]] [[Nova ideia]] [[#Local]] <b>[[x]]</b>';
    const { bodyHtml } = await renderExportBody(doc, {
      renderers: {},
      mode: 'file',
      images,
      wikilinks: exists,
    });
    expect(bodyHtml).toBe(
      '<p><span class="smd-wikilink">a receita</span> <span class="smd-wikilink">Bolo</span> ' +
        '<span class="smd-wikilink">Bolo › Cobertura</span> ' +
        '<span class="smd-wikilink smd-wikilink-missing">Nova ideia</span> ' +
        '<span class="smd-wikilink">Local</span> &lt;b&gt;<span class="smd-wikilink smd-wikilink-missing">x</span>&lt;/b&gt;</p>',
    );
    expect(bodyHtml).not.toMatch(/href|\[\[|\]\]/);
  });

  test('rótulo escapado; sem resolvedor todo wikilink sai como inexistente; código fica cru', async () => {
    const { bodyHtml } = await renderExportBody('[[a<b>|<i>x</i>]] `[[c]]`', {
      renderers: {},
      mode: 'print',
      images,
    });
    expect(bodyHtml).toBe(
      '<p><span class="smd-wikilink smd-wikilink-missing">&lt;i&gt;x&lt;/i&gt;</span> <code>[[c]]</code></p>',
    );
  });
});
