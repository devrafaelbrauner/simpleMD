// @vitest-environment jsdom
import '../../../packages/core/test/setup-dom';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import {
  appPlatformFacet,
  createMarkdownExtensions,
  linkOpenerFacet,
  noteContext,
  openLinkAtCursor,
  urlRefusal,
  type EditorPlatform,
} from '@simplemd/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLinkOpener, LINK_TEXT } from '../src/app/link-opener';
import { fxR7 } from '../harness/fixtures/r7';
import { setup, type Harness } from './helpers';

const views: EditorView[] = [];
afterEach(() => {
  while (views.length) views.pop()?.destroy();
  document.body.innerHTML = '';
});

/** Editor real com o serviço de links do app (o mesmo de `editor/services.ts`). */
function mount(h: Harness, doc: string, notePath: string, os: EditorPlatform = 'mac'): EditorView {
  const parent = document.body.appendChild(document.createElement('div'));
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      selection: { anchor: doc.length },
      extensions: [
        createMarkdownExtensions(),
        appPlatformFacet.of(os),
        noteContext.of({ path: notePath }),
        linkOpenerFacet.of(
          createLinkOpener({ platform: h.platform, store: h.app.store, sync: () => h.app.sync }),
        ),
      ],
    }),
  });
  views.push(view);
  return view;
}

/** O span renderizado do link cujo nome acessível contém `dest`. */
function linkSpan(view: EditorView, dest: string): HTMLElement {
  const span = [...view.contentDOM.querySelectorAll<HTMLElement>('.cm-md-link')].find((el) =>
    el.getAttribute('aria-label')?.includes(dest),
  );
  if (!span) throw new Error(`link sem destino ${dest}`);
  return span;
}

const press = (el: Element, init: MouseEventInit) =>
  el.dispatchEvent(
    new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, ...init }),
  );

async function harness(): Promise<Harness> {
  const h = await setup(fxR7());
  // O harness registra o espelho TS como validação do falso (F-11), como o `main.tsx`.
  h.opener.validate = urlRefusal;
  return h;
}

const lastNotice = (h: Harness) => h.app.store.getState().notices.at(-1);

describe('AC-I1.3 — ⌘/Ctrl-clique abre a URL exata uma vez; clique simples não abre', () => {
  const URL_ = 'https://exemplo.org/a?b=1#c';
  const DOC = `Veja [site](${URL_}) agora.\n\nfim\n`;

  it('macOS: ⌘-clique → 1 chamada com a URL exata; seleção intacta', async () => {
    const h = await harness();
    const view = mount(h, DOC, 'links.md', 'mac');
    const before = view.state.selection.main.head;
    expect(press(linkSpan(view, URL_), { metaKey: true })).toBe(false); // padrão cancelado
    expect(h.opener.calls().map((c) => c.url)).toEqual([URL_]);
    expect(h.opener.accepted()).toHaveLength(1);
    expect(view.state.selection.ranges).toHaveLength(1);
    expect(view.state.selection.main.head).toBe(before);
    // Ctrl-clique no macOS não é o gesto (é o menu de contexto do sistema).
    press(linkSpan(view, URL_), { ctrlKey: true });
    expect(h.opener.calls()).toHaveLength(1);
  });

  it('outras plataformas: Ctrl-clique → 1 chamada; ⌘ (Meta) não abre', async () => {
    const h = await harness();
    const view = mount(h, DOC, 'links.md', 'other');
    press(linkSpan(view, URL_), { ctrlKey: true });
    expect(h.opener.calls().map((c) => c.url)).toEqual([URL_]);
    press(linkSpan(view, URL_), { metaKey: true });
    press(linkSpan(view, URL_), { ctrlKey: true, altKey: true });
    expect(h.opener.calls()).toHaveLength(1);
  });

  it('clique simples: 0 chamadas', async () => {
    const h = await harness();
    const view = mount(h, DOC, 'links.md', 'mac');
    press(linkSpan(view, URL_), {});
    expect(h.opener.calls()).toEqual([]);
  });

  it('"Abrir link sob o cursor" faz a mesma chamada; sem link → aviso STR-137 e 0 chamadas', async () => {
    const h = await harness();
    const view = mount(h, DOC, 'links.md');
    view.dispatch({ selection: { anchor: DOC.indexOf('site') + 2 } });
    expect(openLinkAtCursor(view)).toBe(true);
    expect(h.opener.calls().map((c) => c.url)).toEqual([URL_]);
    view.dispatch({ selection: { anchor: DOC.indexOf('agora') } });
    openLinkAtCursor(view);
    expect(h.opener.calls()).toHaveLength(1);
    expect(lastNotice(h)).toMatchObject({ kind: 'info', text: LINK_TEXT.noLink });
  });
});

describe('AC-I1.4 — matriz de esquemas pelo comando do editor', () => {
  /** Abre o link de `[t](href)` pelo comando e devolve as chamadas ao `open_url` e o último aviso. */
  async function openHref(href: string) {
    const h = await harness();
    const doc = `[t](${href})\n\nfim\n`;
    const view = mount(h, doc, 'links.md');
    view.dispatch({ selection: { anchor: 1 } });
    openLinkAtCursor(view);
    return { calls: h.opener.calls().map((c) => c.url), notice: lastNotice(h) };
  }

  it.each([
    ['http://exemplo.org/http', 'http://exemplo.org/http'],
    ['https://exemplo.org/https', 'https://exemplo.org/https'],
    ['HTTPS://EXEMPLO.ORG/Maiusculo', 'https://exemplo.org/Maiusculo'],
    ['mailto:ana@exemplo.org?subject=Oi', 'mailto:ana@exemplo.org?subject=Oi'],
  ])('%s → 1 chamada (%s), nenhum aviso', async (href, normalized) => {
    const { calls, notice } = await openHref(href);
    expect(calls).toEqual([normalized]);
    expect(notice).toBeUndefined();
  });

  it.each([
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    'file:///etc/passwd',
    'data:text/html,oi',
    'vbscript:msgbox(1)',
    'ftp://exemplo.org/x',
    'smb://servidor/pasta',
    'x-foo:bar',
    'https://usuario:senha@exemplo.org/',
    `https://exemplo.org/${'a'.repeat(2049 - 'https://exemplo.org/'.length)}`,
    'relatorio.pdf',
  ])('%s → 0 chamadas e o aviso "Link não suportado"', async (href) => {
    const { calls, notice } = await openHref(href);
    expect(calls).toEqual([]);
    expect(notice).toMatchObject({ kind: 'info', level: 'warn', notice: 'link' });
    expect(notice?.text.startsWith('Link não suportado: ')).toBe(true);
  });

  it('URL com quebra de linha não forma link: 0 chamadas', async () => {
    const { calls, notice } = await openHref('https://exemplo.org/a\nb');
    expect(calls).toEqual([]);
    expect(notice?.text).toBe(LINK_TEXT.noLink);
  });

  it('o Rust recusando mesmo assim (defesa em profundidade) → aviso de erro STR-141', async () => {
    const h = await harness();
    h.opener.fail = 'URL_INVALID';
    const view = mount(h, '[t](https://exemplo.org/x)\n\nfim\n', 'links.md');
    view.dispatch({ selection: { anchor: 1 } });
    openLinkAtCursor(view);
    await vi.waitFor(() => expect(lastNotice(h)).toMatchObject({ kind: 'error' }));
    expect(lastNotice(h)?.text).toBe(LINK_TEXT.openFailed);
    expect(h.opener.accepted()).toEqual([]);
  });
});

describe('AC-I2.5 — links `.md` relativos', () => {
  it('`[t](../b.md#t)` abre a nota no app e põe o cursor no título; 0 chamadas ao navegador', async () => {
    const h = await harness();
    const doc = '[cobertura](../receitas/Bolo.md#cobertura)\n\nfim\n';
    const view = mount(h, doc, 'notas/relativo.md');
    view.dispatch({ selection: { anchor: 2 } });
    openLinkAtCursor(view);
    await vi.waitFor(() => expect(h.app.store.getState().activeId).toBe('receitas/Bolo.md'));
    expect(h.opener.calls()).toEqual([]);
    expect(h.writes()).toBe(0);
  });

  it('fora do vault → recusado com aviso; nada abre', async () => {
    const h = await harness();
    const view = mount(h, '[fora](../fora.md)\n\nfim\n', 'links.md');
    view.dispatch({ selection: { anchor: 2 } });
    openLinkAtCursor(view);
    expect(lastNotice(h)).toMatchObject({
      level: 'warn',
      text: LINK_TEXT.outside,
      detail: '../fora.md',
    });
    expect(h.app.store.getState().activeId).toBeNull();
    expect(h.port.calls().filter((c) => c.op === 'lstat' && c.abs.includes('fora'))).toEqual([]);
  });

  it('`.md` inexistente → "Nota não encontrada", 0 criações (0 gravações, 0 pastas)', async () => {
    const h = await harness();
    const view = mount(h, '[nada](nao-existe.md)\n\nfim\n', 'links.md');
    view.dispatch({ selection: { anchor: 2 } });
    openLinkAtCursor(view);
    await vi.waitFor(() =>
      expect(lastNotice(h)).toMatchObject({ text: LINK_TEXT.missing, detail: 'nao-existe.md' }),
    );
    expect(h.writes()).toBe(0);
    expect(h.port.calls().filter((c) => c.op === 'mkdirp')).toEqual([]);
    expect(h.port.readBytes('nao-existe.md')).toBeNull();
    expect(h.app.store.getState().activeId).toBeNull();
  });
});

describe('CR-S1-08 — o serviço revalida destinos `external` montados fora do classifyHref', () => {
  it('external inválido → aviso "Link não suportado", 0 chamadas; válido → a forma normalizada', async () => {
    const h = await harness();
    const view = mount(h, 'x\n', 'links.md');
    const opener = createLinkOpener({
      platform: h.platform,
      store: h.app.store,
      sync: () => h.app.sync,
    });
    opener.open({ kind: 'external', url: 'javascript:alert(1)' }, view);
    opener.open({ kind: 'external', url: 'https://u:p@exemplo.org/' }, view);
    expect(h.opener.calls()).toEqual([]);
    expect(lastNotice(h)).toMatchObject({
      level: 'warn',
      text: 'Link não suportado: endereço com usuário e senha',
    });
    opener.open({ kind: 'external', url: 'HTTPS://Exemplo.org/a' }, view);
    expect(h.opener.calls().map((c) => c.url)).toEqual(['https://exemplo.org/a']);
  });
});
