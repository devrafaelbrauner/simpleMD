// @vitest-environment jsdom
import '../../../packages/core/test/setup-dom';
import { EditorState, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import {
  appPlatformFacet,
  createMarkdownExtensions,
  linkOpenerFacet,
  noteContext,
  openLinkAtCursor,
  wikilinkIndexFacet,
  visibleText,
  type LinkTarget,
} from '@simplemd/core';
import { INDEX_PATH } from '@simplemd/vault';
import { wikilinkTipParts } from '../../../packages/core/src/live-preview/wikilinks';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLinkOpener, LINK_TEXT } from '../src/app/link-opener';
import { NOTE_CREATE_TEXT } from '../src/app/note-create';
import { contextWindow, LINKS_CONTEXT_MAX } from '../src/app/useLinksPanel';
import { LinksIndex, type CatalogSource, type ExplorerSource } from '../src/catalog/links';
import { FX_R7_BOLO_SOURCES, fxR7 } from '../harness/fixtures/r7';
import { setup, type Harness } from './helpers';

const views: EditorView[] = [];
afterEach(() => {
  while (views.length) views.pop()?.destroy();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

/** FX-R7 com o índice ligado e pronto (o extrator real do app, com wikilinks). */
async function harness(files = fxR7()): Promise<Harness> {
  const h = await setup(files, { catalog: true });
  await vi.waitFor(() => expect(h.app.catalog.getSnapshot().status).toBe('ready'), {
    timeout: 10_000,
  });
  return h;
}

function extensionsFor(h: Harness, notePath: string): Extension[] {
  return [
    createMarkdownExtensions(),
    appPlatformFacet.of('mac'),
    noteContext.of({ path: notePath }),
    wikilinkIndexFacet.of(h.app.catalog.links),
    linkOpenerFacet.of(
      createLinkOpener({
        platform: h.platform,
        store: h.app.store,
        sync: () => h.app.sync,
        catalog: () => h.app.catalog,
      }),
    ),
  ];
}

/** Editor real com o serviço de links e o índice de wikilinks do app (os de `editor/services.ts`). */
function mount(h: Harness, doc: string, notePath: string): EditorView {
  const parent = document.body.appendChild(document.createElement('div'));
  const view = new EditorView({
    parent,
    state: EditorState.create({ doc, extensions: extensionsFor(h, notePath) }),
  });
  views.push(view);
  return view;
}

/** O editor do app troca de documento quando a aba ativa muda (o efeito do React, aqui à mão). */
async function follow(h: Harness, view: EditorView, path: string): Promise<void> {
  await vi.waitFor(() => {
    expect(h.app.store.getState().activeId).toBe(path);
    expect(h.app.store.getState().docs[path]).toBe('clean');
  });
  view.setState(
    EditorState.create({ doc: h.text(path) ?? '', extensions: extensionsFor(h, path) }),
  );
}

const lastNotice = (h: Harness) => h.app.store.getState().notices.at(-1);
const tabs = (h: Harness) => h.app.store.getState().tabs.map((t) => t.path);
const writeCalls = (h: Harness) => h.port.calls().filter((c) => c.op === 'writeFile');
const mkdirCalls = (h: Harness) => h.port.calls().filter((c) => c.op === 'mkdirp');

/** Cursor dentro do wikilink `text` (primeira ocorrência) e o comando "Abrir link sob o cursor". */
function openAt(view: EditorView, text: string): void {
  const at = view.state.doc.toString().indexOf(text);
  if (at < 0) throw new Error(`sem ${text}`);
  view.dispatch({ selection: { anchor: at + 3 } });
  openLinkAtCursor(view);
}

const WIKI = '# Wikilinks\n\n[[Bolo]] [[Bolo#Cobertura]] [[Bolo#Recheio]] [[#Wikilinks]]\n\nfim\n';

describe('AC-I2.3 — abrir wikilink resolvido (VT; o PW cobre a pintura)', () => {
  it('⌘-clique em [[Bolo]] com a nota fechada abre uma aba nova; cursor no topo; 0 gravações', async () => {
    const h = await harness();
    const view = mount(h, WIKI, 'wikilinks.md');
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    const span = [...view.contentDOM.querySelectorAll<HTMLElement>('[data-testid=cm-wikilink]')][0];
    expect(span?.getAttribute('data-resolved')).toBe('true');
    span?.dispatchEvent(
      new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, metaKey: true }),
    );
    await follow(h, view, 'receitas/Bolo.md');
    expect(tabs(h)).toEqual(['receitas/Bolo.md']);
    await vi.waitFor(() => expect(view.state.selection.main.head).toBe(0));
    expect(writeCalls(h)).toEqual([]);
    expect(h.opener.calls()).toEqual([]);
  });

  it('com a nota já aberta ativa a aba existente (0 abas novas)', async () => {
    const h = await harness();
    await h.app.sync.openFile('receitas/Bolo.md');
    await h.app.sync.openFile('wikilinks.md');
    expect(tabs(h)).toEqual(['receitas/Bolo.md', 'wikilinks.md']);
    const view = mount(h, WIKI, 'wikilinks.md');
    openAt(view, '[[Bolo]]');
    await vi.waitFor(() => expect(h.app.store.getState().activeId).toBe('receitas/Bolo.md'));
    expect(tabs(h)).toEqual(['receitas/Bolo.md', 'wikilinks.md']);
  });

  it('[[Bolo#Cobertura]] põe o cursor na linha do título "## Cobertura"', async () => {
    const h = await harness();
    const view = mount(h, WIKI, 'wikilinks.md');
    openAt(view, '[[Bolo#Cobertura]]');
    await follow(h, view, 'receitas/Bolo.md');
    await vi.waitFor(() => {
      const line = view.state.doc.lineAt(view.state.selection.main.head);
      expect(line.text).toBe('## Cobertura');
      expect(line.number).toBe(9);
    });
    expect(h.app.store.getState().notices.filter((n) => n.text === LINK_TEXT.heading)).toEqual([]);
  });

  it('[[Bolo#Recheio]] (título ausente) → topo + aviso "Título não encontrado:"', async () => {
    const h = await harness();
    const view = mount(h, WIKI, 'wikilinks.md');
    openAt(view, '[[Bolo#Recheio]]');
    await follow(h, view, 'receitas/Bolo.md');
    await vi.waitFor(() =>
      expect(lastNotice(h)).toMatchObject({
        level: 'warn',
        text: LINK_TEXT.heading,
        detail: 'Recheio',
      }),
    );
    expect(view.state.selection.main.head).toBe(0);
  });

  it('[[#Wikilinks]] leva ao título na própria nota, sem abrir aba', async () => {
    const h = await harness();
    const view = mount(h, WIKI, 'wikilinks.md');
    openAt(view, '[[#Wikilinks]]');
    expect(view.state.selection.main.head).toBe(0);
    expect(tabs(h)).toEqual([]);
  });
});

describe('AC-I2.4 — criar nota por wikilink inexistente', () => {
  it('[[Nova ideia]] cria "<pasta da nota>/Nova ideia.md" com 0 bytes (create-new) e abre', async () => {
    const h = await harness();
    const view = mount(h, 'Ideia: [[Nova ideia]]\n', 'notas/relativo.md');
    const span = view.contentDOM.querySelector<HTMLElement>('[data-testid=cm-wikilink]');
    expect(span?.getAttribute('data-resolved')).toBe('false');
    expect(span?.className).toContain('cm-md-wikilink-missing');
    openAt(view, '[[Nova ideia]]');
    await follow(h, view, 'notas/Nova ideia.md');
    const bytes = h.port.readBytes('notas/Nova ideia.md');
    expect(bytes?.length).toBe(0);
    expect(writeCalls(h).map((c) => [c.abs, c.mode, c.bytes?.length])).toEqual([
      ['/vault/notas/Nova ideia.md', 'create-new', 0],
    ]);
    expect(lastNotice(h)).toMatchObject({
      notice: 'note-create',
      text: NOTE_CREATE_TEXT.created,
      detail: 'notas/Nova ideia.md',
    });
    // O índice e o explorador já têm a nota: o mesmo wikilink agora resolve (aceso).
    await vi.waitFor(() =>
      expect(h.app.catalog.links.resolve('Nova ideia', 'notas/relativo.md')).toMatchObject({
        kind: 'resolved',
        path: 'notas/Nova ideia.md',
      }),
    );
  });

  it('na raiz: [[Nova ideia]] de wikilinks.md cria "Nova ideia.md"', async () => {
    const h = await harness();
    const view = mount(h, '[[Nova ideia]]\n', 'wikilinks.md');
    openAt(view, '[[Nova ideia]]');
    await follow(h, view, 'Nova ideia.md');
    expect(h.port.readText('Nova ideia.md')).toBe('');
  });

  it('[[x/y/z]] cria as pastas x/y e a nota x/y/z.md (a partir da raiz)', async () => {
    const h = await harness();
    const view = mount(h, '[[x/y/z]]\n', 'notas/relativo.md');
    openAt(view, '[[x/y/z]]');
    await follow(h, view, 'x/y/z.md');
    expect(h.port.readText('x/y/z.md')).toBe('');
    expect(mkdirCalls(h).map((c) => c.abs)).toEqual(['/vault/x/y']);
  });

  // R-I2.5: ≥ 12 nomes inválidos → aviso STR-150 e 0 gravações / 0 pastas.
  const INVALID: Array<[target: string, reason: string]> = [
    ['CON', 'é um nome reservado do Windows (CON)'],
    ['aux', 'é um nome reservado do Windows (AUX)'],
    ['com1.txt', 'é um nome reservado do Windows (COM1)'],
    ['a:b', 'contém : (dois-pontos)'],
    ['a*b', 'contém * (asterisco)'],
    ['a?b', 'contém ? (ponto de interrogação)'],
    ['a"b', 'contém " (aspas)'],
    ['a<b', 'contém < (sinal de menor)'],
    ['a>b', 'contém > (sinal de maior)'],
    ['a\\b', 'contém \\ (barra invertida)'],
    ['a|b', 'contém | (barra vertical)'],
    ['a\u0001b', 'contém caractere de controle'],
    ['a\u202Eb', 'contém caractere invisível'],
    ['a\u200Bb', 'contém caractere invisível'],
    ['/~x', 'o caminho não é permitido'],
    ['x .md', 'termina com ponto ou espaço'],
    ['.simplemd/x', 'começa com ponto'],
    ['.oculta', 'começa com ponto'],
    ['../fora', 'usa . ou .. como pasta'],
    ['x.', 'termina com ponto ou espaço'],
    ['pasta /x', 'termina com ponto ou espaço'],
    ['a//b', 'tem um trecho vazio'],
    ['ç'.repeat(130), 'um trecho passa de 255 bytes'],
  ];

  it.each(INVALID)('nome inválido %j → aviso, 0 gravações', async (target, reason) => {
    const h = await harness();
    const view = mount(h, 'x\n', 'notas/relativo.md');
    const opener = view.state.facet(linkOpenerFacet);
    h.port.resetCalls();
    opener?.open({ kind: 'wikilink', target, heading: null, fromPath: 'notas/relativo.md' }, view);
    await h.app.sync.refreshList();
    expect(lastNotice(h)).toMatchObject({
      level: 'warn',
      notice: 'note-create',
      text: `Nome de nota inválido: “${visibleText(target)}” — ${reason}.`,
    });
    expect(writeCalls(h)).toEqual([]);
    expect(mkdirCalls(h)).toEqual([]);
    expect(tabs(h)).toEqual([]);
  });

  it('caminho > 1.024 caracteres → aviso PATH_TOO_LONG, 0 gravações', async () => {
    const h = await harness();
    const view = mount(h, 'x\n', 'wikilinks.md');
    const target = Array.from({ length: 6 }, () => 'p'.repeat(200)).join('/');
    view.state
      .facet(linkOpenerFacet)
      ?.open({ kind: 'wikilink', target, heading: null, fromPath: 'wikilinks.md' }, view);
    expect(lastNotice(h)?.text).toBe(
      `Nome de nota inválido: “${target}” — o caminho passa de 1.024 caracteres.`,
    );
    expect(writeCalls(h)).toEqual([]);
  });

  it('corrida: o arquivo aparece por fora entre a resolução e a gravação → abre o existente, 0 sobrescritas', async () => {
    const h = await harness();
    const view = mount(h, '[[Corrida]]\n', 'wikilinks.md');
    expect(h.app.catalog.links.resolve('Corrida', 'wikilinks.md').kind).toBe('missing');
    // Outro programa cria o arquivo logo antes da gravação só-criação chegar ao disco.
    const write = h.port.writeFile.bind(h.port);
    vi.spyOn(h.port, 'writeFile').mockImplementationOnce(async (abs, data, mode) => {
      h.port.externalWrite('Corrida.md', 'conteúdo de fora\n');
      return write(abs, data, mode);
    });
    openAt(view, '[[Corrida]]');
    await follow(h, view, 'Corrida.md');
    expect(h.port.readText('Corrida.md')).toBe('conteúdo de fora\n');
    expect(writeCalls(h).map((c) => c.mode)).toEqual(['create-new']);
    expect(h.text('Corrida.md')).toBe('conteúdo de fora\n');
    expect(lastNotice(h)).toMatchObject({
      notice: 'note-create',
      text: NOTE_CREATE_TEXT.existed('Corrida.md'),
    });
  });

  it('o índice ainda não viu a nota criada por fora: ALREADY_EXISTS na guarda → abre o existente', async () => {
    const h = await setup(fxR7(), { catalog: true, watch: false });
    await vi.waitFor(() => expect(h.app.catalog.getSnapshot().status).toBe('ready'), {
      timeout: 10_000,
    });
    h.port.externalWrite('Fora.md', 'já existia\n');
    const view = mount(h, '[[Fora]]\n', 'wikilinks.md');
    h.port.resetCalls();
    openAt(view, '[[Fora]]');
    await follow(h, view, 'Fora.md');
    expect(writeCalls(h)).toEqual([]);
    expect(h.port.readText('Fora.md')).toBe('já existia\n');
  });

  it('falha de E/S → aviso de erro com o caminho; nada abre', async () => {
    const h = await harness();
    const view = mount(h, '[[Falha]]\n', 'wikilinks.md');
    h.port.failNext('writeFile', 'IO', 'Falha.md');
    openAt(view, '[[Falha]]');
    await vi.waitFor(() => expect(lastNotice(h)?.kind).toBe('error'));
    expect(lastNotice(h)?.text).toMatch(/^Não foi possível criar “Falha\.md”: .+\.$/);
    expect(tabs(h)).toEqual([]);
    expect(h.port.readBytes('Falha.md')).toBeNull();
  });

  it('o provider recusa o caminho (permissão) → "Nome de nota inválido … não é permitido"', async () => {
    const h = await harness();
    const view = mount(h, '[[Negado]]\n', 'wikilinks.md');
    h.port.failNext('writeFile', 'PERMISSION_DENIED', 'Negado.md');
    openAt(view, '[[Negado]]');
    await vi.waitFor(() => expect(lastNotice(h)?.text).toBe(NOTE_CREATE_TEXT.refused('Negado')));
    expect(tabs(h)).toEqual([]);
  });

  it('sem catálogo (runtime sem app): resolve como inexistente e cria pelo caminho do wikilink', async () => {
    const h = await setup(fxR7());
    const parent = document.body.appendChild(document.createElement('div'));
    const opener = createLinkOpener({
      platform: h.platform,
      store: h.app.store,
      sync: () => h.app.sync,
    });
    const view = new EditorView({ parent, state: EditorState.create({ doc: 'x\n' }) });
    views.push(view);
    const target: LinkTarget = {
      kind: 'wikilink',
      target: 'Solta',
      heading: null,
      fromPath: 'notas/relativo.md',
    };
    opener.open(target, view);
    await vi.waitFor(() => expect(h.app.store.getState().activeId).toBe('notas/Solta.md'));
    expect(h.port.readText('notas/Solta.md')).toBe('');
  });
});

describe('CR-S2-03 — dica W1 e clique usam a mesma validação de nome', () => {
  it('LinksIndex.resolve: inexistente válido → caminho do clique; inválido → a recusa STR-150', async () => {
    const h = await harness();
    const links = h.app.catalog.links;
    expect(links.resolve('Nova', 'notas/relativo.md')).toEqual({
      kind: 'missing',
      createPath: 'notas/Nova.md',
    });
    expect(links.resolve('CON', 'wikilinks.md')).toEqual({
      kind: 'missing',
      createPath: '',
      refused: 'Nome de nota inválido: “CON” — é um nome reservado do Windows (CON).',
    });
    expect(links.resolve('x .md', 'wikilinks.md')).toMatchObject({
      refused: 'Nome de nota inválido: “x .md” — termina com ponto ou espaço.',
    });
    expect(links.resolve('~x', 'wikilinks.md')).toMatchObject({
      refused: 'Nome de nota inválido: “~x” — o caminho não é permitido.',
    });
    expect(links.resolve('a\u202Eb', 'wikilinks.md')).toMatchObject({
      refused: 'Nome de nota inválido: “a%E2%80%AEb” — contém caractere invisível.',
    });
  });

  it('a dica do editor mostra a recusa e o clique recusa com o mesmo texto (0 gravações)', async () => {
    const h = await harness();
    const view = mount(h, '[[CON]]\n', 'wikilinks.md');
    const tip = wikilinkTipParts(view.state, 'CON', true)
      .map((p) => p.text)
      .join('');
    expect(tip).toBe(
      'Nota inexistente. Nome de nota inválido: “CON” — é um nome reservado do Windows (CON).',
    );
    h.port.resetCalls();
    openAt(view, '[[CON]]');
    await vi.waitFor(() =>
      expect(lastNotice(h)?.text).toBe(tip.slice('Nota inexistente. '.length)),
    );
    expect(writeCalls(h)).toEqual([]);
  });
});

describe('LinksIndex — união índice ∪ explorador, versão e backlinks', () => {
  function sources(
    entries: Array<{ path: string; links?: Array<[string, 'wikilink' | 'inline']> }>,
  ) {
    let snapshot = {
      status: 'ready' as const,
      done: 0,
      total: 0,
      version: 1,
      entries: entries.map((e) => ({
        path: e.path,
        mtime: 1,
        size: 1,
        title: e.path,
        headings: [],
        properties: {},
        fmError: false,
        links: (e.links ?? []).map(([target, kind]) => ({
          line: 0,
          column: 0,
          length: 4,
          kind,
          target,
        })),
        truncated: [] as Array<'links'>,
      })),
    };
    const catalogListeners = new Set<() => void>();
    const catalog: CatalogSource = {
      getSnapshot: () => snapshot as never,
      subscribe: (l) => {
        catalogListeners.add(l);
        return () => catalogListeners.delete(l);
      },
    };
    let explorer: Array<{ path: string; kind: 'file' | 'dir'; name: string }> = [];
    const explorerListeners = new Set<() => void>();
    const tree: ExplorerSource = {
      entries: () => explorer as never,
      subscribe: (l) => {
        explorerListeners.add(l);
        return () => explorerListeners.delete(l);
      },
    };
    return {
      catalog,
      tree,
      setEntries(next: typeof entries) {
        snapshot = {
          ...snapshot,
          version: snapshot.version + 1,
          entries: sources(next).snapshot().entries,
        };
        for (const l of catalogListeners) l();
      },
      setExplorer(paths: string[]) {
        explorer = paths.map((path) => ({ path, kind: 'file' as const, name: path }));
        for (const l of explorerListeners) l();
      },
      snapshot: () => snapshot,
    };
  }

  it('nota só no explorador (o índice ainda lê) já resolve; versão muda só quando o conjunto muda', () => {
    const s = sources([{ path: 'a.md', links: [['b', 'wikilink']] }]);
    const links = new LinksIndex(s.catalog, s.tree);
    const listener = vi.fn();
    links.subscribe(listener);
    const v0 = links.version;
    expect(links.resolve('b', 'a.md').kind).toBe('missing');
    s.setExplorer(['a.md', 'b.md', 'img/x.png']);
    expect(links.version).toBe(v0 + 1);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(links.resolve('b', 'a.md')).toMatchObject({ kind: 'resolved', path: 'b.md' });
    // Mesmo conjunto (o índice leu b.md): versão igual, 0 avisos.
    s.setEntries([{ path: 'a.md', links: [['b', 'wikilink']] }, { path: 'b.md' }]);
    expect(links.version).toBe(v0 + 1);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(links.exists('B', 'a.md')).toBe(true);
    expect(links.backlinks('b.md').groups.map((g) => g.path)).toEqual(['a.md']);
  });

  it('backlinks incrementais: origem passa a apontar e deixa de apontar', () => {
    const s = sources([
      { path: 'a.md' },
      { path: 'b.md' },
      { path: 'c.md', links: [['b.md', 'inline']] },
    ]);
    const links = new LinksIndex(s.catalog, s.tree);
    expect(links.backlinks('b.md')).toMatchObject({ links: 1, groups: [{ path: 'c.md' }] });
    s.setEntries([
      {
        path: 'a.md',
        links: [
          ['b', 'wikilink'],
          ['b', 'wikilink'],
        ],
      },
      { path: 'b.md' },
      { path: 'c.md', links: [['b.md', 'inline']] },
    ]);
    expect(links.backlinks('b.md')).toMatchObject({ links: 3 });
    expect(links.backlinks('b.md').groups.map((g) => g.path)).toEqual(['a.md', 'c.md']);
    s.setEntries([{ path: 'a.md' }, { path: 'b.md' }, { path: 'c.md' }]);
    expect(links.backlinks('b.md')).toEqual({ groups: [], links: 0 });
    expect(links.overLimit('a.md')).toBe(false);
    expect(links.overLimit('nada.md')).toBe(false);
  });
});

describe('contexto do painel Links (≤ 200 caracteres, trecho do link dentro)', () => {
  it('linha curta: inteira', () => {
    expect(contextWindow('Fiz o [[Bolo]] para o café.', 6, 8)).toEqual({
      context: 'Fiz o [[Bolo]] para o café.',
      matchFrom: 6,
      matchTo: 14,
    });
  });

  it('linha longa: recorte de 200 com o link no meio; no fim e no começo', () => {
    const line = `${'a'.repeat(300)}[[Bolo]]${'b'.repeat(300)}`;
    const mid = contextWindow(line, 300, 8);
    expect(mid.context).toHaveLength(LINKS_CONTEXT_MAX);
    expect(mid.context.slice(mid.matchFrom, mid.matchTo)).toBe('[[Bolo]]');
    const end = contextWindow(`${'a'.repeat(400)}[[Bolo]]`, 400, 8);
    expect(end.context).toHaveLength(200);
    expect(end.context.endsWith('[[Bolo]]')).toBe(true);
    expect(end.context.slice(end.matchFrom, end.matchTo)).toBe('[[Bolo]]');
    const start = contextWindow(`[[Bolo]]${'b'.repeat(400)}`, 0, 8);
    expect(start).toMatchObject({ matchFrom: 0, matchTo: 8 });
    expect(start.context).toHaveLength(200);
    const huge = contextWindow(`x${'[['.padEnd(300, 'c')}`, 1, 300);
    expect(huge.context).toHaveLength(200);
    expect(huge.matchFrom).toBe(0);
    expect(huge.matchTo).toBe(200);
  });
});

describe('AC-I2.6 / AC-I2.8 — catálogo do app com o extrator real (FX-R7)', () => {
  it('backlinks de receitas/Bolo.md = FX_R7_BOLO_SOURCES (wikilink + .md relativo); a própria fora', async () => {
    const h = await harness();
    const backlinks = h.app.catalog.links.backlinks('receitas/Bolo.md');
    expect(backlinks.groups.map((g) => g.path).sort()).toEqual([...FX_R7_BOLO_SOURCES].sort());
    const wiki = backlinks.groups.find((g) => g.path === 'wikilinks.md');
    // Bolo, bolo, Bolo|a receita, Bolo#Cobertura, Bolo#Recheio, receitas/Bolo, receitas/Bolo.md e
    // o apelido escapado da tabela; `[[x]]` em código, `\[[x]]` e `![[Bolo]]` ficam fora.
    expect(wiki?.occurrences).toHaveLength(8);
    expect(backlinks.groups.find((g) => g.path === 'notas/relativo.md')?.occurrences).toHaveLength(
      2,
    );
    expect(backlinks.groups.every((g) => g.path !== 'receitas/Bolo.md')).toBe(true);
    // Ambígua: [[Nota]] de a/vizinha.md → a/Nota.md (mesma pasta).
    expect(h.app.catalog.links.backlinks('a/Nota.md').groups.map((g) => g.path)).toContain(
      'a/vizinha.md',
    );
  });

  it('salvar no app atualiza os backlinks sem ler o .md (aparece e some)', async () => {
    const h = await harness();
    h.port.resetCalls();
    const sources = () =>
      h.app.catalog.links.backlinks('receitas/Bolo.md').groups.map((g) => g.path);
    h.app.catalog.saved('Pao.md', '# Pao\n\nVer [[Bolo]].\n', Date.now());
    await vi.waitFor(() => expect(sources()).toContain('Pao.md'));
    h.app.catalog.saved('Pao.md', '# Pao\n\nSem link.\n', Date.now() + 1);
    await vi.waitFor(() => expect(sources()).not.toContain('Pao.md'));
    expect(h.port.calls().filter((c) => c.op === 'readFile' && c.abs.endsWith('.md'))).toEqual([]);
  });

  it('reabrir com o índice v2 quente: 0 leituras de .md e os mesmos backlinks', async () => {
    const h = await harness();
    await vi.waitFor(() => expect(h.port.readText(INDEX_PATH)).not.toBeNull(), { timeout: 5000 });
    await h.app.catalog.flush();
    const before = h.app.catalog.links.backlinks('receitas/Bolo.md');
    h.port.resetCalls();
    await h.app.sync.openVault('shell');
    await vi.waitFor(() => expect(h.app.catalog.getSnapshot().status).toBe('ready'), {
      timeout: 10_000,
    });
    expect(h.port.calls().filter((c) => c.op === 'readFile' && c.abs.endsWith('.md'))).toEqual([]);
    expect(h.app.catalog.links.backlinks('receitas/Bolo.md')).toEqual(before);
  });
});

describe('AC-EX.3 — exportação do app: wikilinks como texto estilizado', () => {
  it('wikilinks.md exportado: rótulos sem href nem colchetes; inexistentes com a classe própria', async () => {
    Object.defineProperty(document, 'fonts', {
      value: { ready: Promise.resolve(), load: async () => [] },
      configurable: true,
    });
    const h = await harness();
    await h.app.sync.openFile('wikilinks.md');
    await h.app.exporter.exportHtml();
    const bytes = h.platform.saveTarget.write.mock.calls.at(-1)?.[1];
    const doc = new DOMParser().parseFromString(new TextDecoder().decode(bytes), 'text/html');
    const spans = [...doc.querySelectorAll('span.smd-wikilink')].map((s) => [
      s.textContent,
      s.className,
    ]);
    expect(spans).toEqual([
      ['Bolo', 'smd-wikilink'],
      ['bolo', 'smd-wikilink'],
      ['a receita', 'smd-wikilink'],
      ['Bolo › Cobertura', 'smd-wikilink'],
      ['Bolo › Recheio', 'smd-wikilink'],
      ['Wikilinks', 'smd-wikilink'],
      ['receitas/Bolo', 'smd-wikilink'],
      ['receitas/Bolo.md', 'smd-wikilink'],
      ['Nota', 'smd-wikilink'],
      ['Pão', 'smd-wikilink'],
      ['Pao', 'smd-wikilink'],
      ['Nova ideia', 'smd-wikilink smd-wikilink-missing'],
      ['x/y/z', 'smd-wikilink smd-wikilink-missing'],
      ['na tabela', 'smd-wikilink'],
    ]);
    expect([...doc.querySelectorAll('span.smd-wikilink')].every((s) => !s.closest('a'))).toBe(true);
    expect(doc.body.textContent).not.toContain('[[Bolo');
    expect([...doc.querySelectorAll('a')].map((a) => a.getAttribute('href'))).not.toContainEqual(
      expect.stringContaining('Bolo'),
    );
  });
});
