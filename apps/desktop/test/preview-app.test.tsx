// @vitest-environment jsdom
import '../../../packages/core/test/setup-dom';
import { createHash } from 'node:crypto';
import type { EditorView } from '@codemirror/view';
import { builtinHotkeys, normalizeHotkey } from '@simplemd/plugin-api/runtime';
import { CONFIG_PATH } from '@simplemd/themes';
import { editorViewConstructions } from '@simplemd/ui';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { App } from '../src/app/App';
import { matchGlobalKey, TOGGLE_SIDE_PREVIEW_KEY } from '../src/app/global-keys';
import { SIDE_PREVIEW_TEXT } from '../src/app/useBuiltinCommands';
import type * as Pipeline from '../src/export/pipeline';
import { PREVIEW_BLOCK_CLASS, PREVIEW_REFUSED_CLASS } from '../src/preview/controller';
import { PREFS_SAVE_DEBOUNCE_MS } from '../src/state/settings';
import { fxR7 } from '../harness/fixtures/r7';
import { setup, type Harness } from './helpers';

/**
 * `previewBody` sob controle do teste: blocos forçados (um bloco que o `assertInert` recusa); sem
 * eles, a pipeline real da exportação.
 */
const forced = vi.hoisted(() => ({ blocks: null as { line: number; html: string }[] | null }));
vi.mock('../src/export/pipeline', async (importOriginal) => {
  const original = await importOriginal<typeof Pipeline>();
  return {
    ...original,
    previewBody: async (...args: Parameters<typeof original.previewBody>) =>
      forced.blocks ?? (await original.previewBody(...args)),
  };
});

/**
 * r38b (design-r38 §7): a prévia lado a lado no app real — `Mod-Shift-D`, o comando da paleta, o
 * divisor e `layout.preview` no `config.json`. Um `EditorView` só; a nota nunca é gravada pela
 * prévia; o `config.json` só muda depois de uma escolha (inválido avisa e não é regravado).
 */
afterEach(() => {
  cleanup();
  forced.blocks = null;
  vi.restoreAllMocks();
  vi.useRealTimers();
  Reflect.deleteProperty(window, '__xss');
});

const A = '# Título A\n\nTexto **forte** e `código`.\n\n- item um\n- item dois\n';
const B = '# Nota B\n\nOutra nota.\n';
const COMMAND = 'editor:toggle-side-preview';

/** Ctrl+Shift+D (o jsdom não é macOS): o atalho global roda na captura da janela. */
function pressToggle(target: Element = document.body): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key: 'D',
    code: 'KeyD',
    ctrlKey: true,
    shiftKey: true,
    bubbles: true,
    cancelable: true,
  });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

async function openApp(files: Record<string, string> = { 'a.md': A, 'b.md': B }, open = 'a.md') {
  const h = await setup(files);
  render(<App app={h.app} />);
  await act(async () => {
    await h.app.sync.openFile(open);
  });
  return h;
}

function editorOf(h: Harness): EditorView {
  const view = h.app.plugins.editor.view;
  if (!view) throw new Error('editor não montado');
  return view;
}

const host = () => screen.queryByTestId('preview-host');
const announced = (h: Harness) => editorOf(h).dom.querySelector('.cm-announced')?.textContent;
/** Gravações por caminho relativo ao vault. */
const writtenPaths = (h: Harness) =>
  h.port
    .calls()
    .filter((call) => call.op === 'writeFile')
    .map((call) => call.abs.replace(/^\/vault\//, ''));

/** Espera a renderização da prévia inserida (o motor carrega a pipeline por `import()`). */
async function waitReady(h: Harness, generation = 1): Promise<void> {
  await act(async () => {
    await vi.waitFor(
      () => {
        const status = h.app.preview.status.getSnapshot();
        expect(status.kind === 'ready' && status.generation >= generation).toBe(true);
      },
      { timeout: 15_000, interval: 10 },
    );
  });
}

describe('AC-R38-1: Mod-Shift-D mostra o HTML da nota ao lado, atualizado ao digitar', () => {
  test('Ctrl+Shift+D abre ao lado do MESMO editor; a nota não é gravada; fechar devolve o foco', async () => {
    const h = await openApp();
    const view = editorOf(h);
    const constructions = editorViewConstructions();
    expect(screen.queryByTestId('preview-pane')).toBeNull();
    expect(h.app.preview.status.getSnapshot().kind).toBe('off');

    expect(pressToggle(view.contentDOM).defaultPrevented).toBe(true);
    const region = screen.getByRole('region', { name: 'Prévia — a.md' });
    expect(region.textContent).toContain('Só leitura');
    expect(announced(h)).toBe(SIDE_PREVIEW_TEXT.opened);
    await waitReady(h);
    const blocks = [...(host()?.querySelectorAll(`:scope > .${PREVIEW_BLOCK_CLASS}`) ?? [])];
    expect(blocks.map((block) => block.getAttribute('data-line'))).toEqual(['1', '3', '5']);
    expect(host()?.querySelector('h1')?.textContent).toBe('Título A');
    expect(host()?.querySelector('strong')?.textContent).toBe('forte');
    expect(host()?.querySelectorAll('li')).toHaveLength(2);
    // O editor fica onde estava (primeiro lado do divisor), sem EditorView novo.
    expect(screen.getByRole('separator').previousElementSibling?.contains(view.dom)).toBe(true);
    expect(h.app.plugins.editor.view).toBe(view);

    // Fechar pelo botão: o painel sai, o motor para e o foco volta ao editor.
    fireEvent.click(screen.getByRole('button', { name: 'Fechar prévia' }));
    expect(screen.queryByTestId('preview-pane')).toBeNull();
    expect(screen.queryByRole('separator')).toBeNull();
    expect(h.app.preview.status.getSnapshot().kind).toBe('off');
    expect(announced(h)).toBe(SIDE_PREVIEW_TEXT.closed);
    await act(async () => {
      await vi.waitFor(() => expect(document.activeElement).toBe(view.contentDOM));
    });
    expect(editorViewConstructions() - constructions).toBe(0);

    // Só o `config.json` (a escolha "aberta/fechada") é gravado; a nota nunca.
    await act(async () => {
      await vi.waitFor(() => expect(writtenPaths(h)).toContain(CONFIG_PATH), { timeout: 3000 });
    });
    expect(writtenPaths(h).every((path) => path === CONFIG_PATH)).toBe(true);
    expect(h.text('a.md')).toBe(A);
    expect(h.app.store.getState().docs['a.md']).toBe('clean');
  });

  test('digitar atualiza a prévia depois do debounce; trocar de aba mostra a outra nota', async () => {
    const h = await openApp();
    const view = editorOf(h);
    pressToggle();
    await waitReady(h);
    act(() => {
      view.dispatch({ changes: { from: view.state.doc.length, insert: '\n## Novo\n' } });
    });
    // Nada é renderizado na mesma tecla (debounce de ≥ 300 ms).
    expect(host()?.querySelector('h2')).toBeNull();
    await waitReady(h, 2);
    expect(host()?.querySelector('h2')?.textContent).toBe('Novo');
    expect(h.text('a.md')).toBe(`${A}\n## Novo\n`);

    await act(async () => {
      await h.app.sync.openFile('b.md');
    });
    expect(screen.getByRole('heading', { level: 2, name: 'Prévia — b.md' })).toBeTruthy();
    await act(async () => {
      await vi.waitFor(() => expect(host()?.querySelector('h1')?.textContent).toBe('Nota B'), {
        timeout: 15_000,
      });
    });
    expect(h.app.plugins.editor.view).toBe(view);
  });

  test('paleta: "Editor: alternar prévia lado a lado" com Ctrl+Shift+D; sem nota, desabilitado', async () => {
    const h = await setup({ 'a.md': A });
    render(<App app={h.app} />);
    const command = h.app.plugins.commands.get(COMMAND);
    expect(command?.title).toBe(SIDE_PREVIEW_TEXT.command);
    expect(command?.hotkey).toBe(TOGGLE_SIDE_PREVIEW_KEY);
    expect(command?.isEnabled?.()).toEqual({ reason: 'Abra uma nota primeiro.' });
    // A tecla sem nota: só o aviso com o motivo, nada abre e nada é gravado.
    expect(pressToggle().defaultPrevented).toBe(true);
    expect(h.app.store.getState().layoutPreview.open).toBe(false);
    expect(h.app.store.getState().notices.map((n) => [n.notice, n.text])).toContainEqual([
      'preview',
      'Abra uma nota primeiro.',
    ]);

    await act(async () => {
      await h.app.sync.openFile('a.md');
    });
    expect(command?.isEnabled?.()).toBe(true);
    act(() => {
      void command?.run();
    });
    expect(screen.getByTestId('preview-pane')).toBeTruthy();
    act(() => {
      void command?.run();
    });
    expect(screen.queryByTestId('preview-pane')).toBeNull();
    // Atalho global (Classe A) reservado para plugins: ⌘⇧D no macOS, Ctrl+Shift+D nos demais.
    const key = { metaKey: false, ctrlKey: false, altKey: false, shiftKey: true };
    expect(matchGlobalKey({ ...key, key: 'D', metaKey: true }, 'mac')).toBe('toggle-side-preview');
    expect(matchGlobalKey({ ...key, key: 'd', ctrlKey: true }, 'other')).toBe(
      'toggle-side-preview',
    );
    expect(matchGlobalKey({ ...key, key: 'd', ctrlKey: true, shiftKey: false }, 'other')).toBe(
      null,
    );
    for (const platform of ['mac', 'other'] as const)
      expect(builtinHotkeys([], platform).has(normalizeHotkey('Mod-Shift-d', platform))).toBe(true);
  });
});

describe('900 px: indisponível com o motivo (design-r38 §1)', () => {
  test('editor estreito: comando desabilitado com a largura, tecla avisa; aberta, esconde e anuncia', async () => {
    const h = await openApp();
    const command = h.app.plugins.commands.get(COMMAND);
    act(() => h.app.store.setState({ editorWidth: 720 }));
    expect(command?.isEnabled?.()).toEqual({
      reason:
        'Precisa de 900 px no editor (agora 720 px). Feche o painel lateral ou aumente a janela.',
    });
    pressToggle();
    expect(h.app.store.getState().layoutPreview.open).toBe(false);
    expect(h.app.store.getState().notices.at(-1)?.text).toBe(
      'Precisa de 900 px no editor (agora 720 px). Feche o painel lateral ou aumente a janela.',
    );

    act(() => h.app.store.setState({ editorWidth: 1040 }));
    pressToggle();
    await waitReady(h);
    // A janela estreita com a prévia aberta: some, o motor para, o editor diz por quê.
    act(() => h.app.store.setState({ editorWidth: 800 }));
    expect(screen.queryByTestId('preview-pane')).toBeNull();
    expect(h.app.preview.status.getSnapshot().kind).toBe('off');
    expect(announced(h)).toBe('Prévia lado a lado escondida: o editor tem 800 px (mínimo 900).');
    // Fechar sempre pode; a escolha "aberta" continua e a prévia volta quando cabe.
    expect(command?.isEnabled?.()).toBe(true);
    expect(h.app.store.getState().layoutPreview.open).toBe(true);
    act(() => h.app.store.setState({ editorWidth: 960 }));
    expect(screen.getByTestId('preview-pane')).toBeTruthy();
    await waitReady(h, 2);
  });
});

describe('AC-R38-2: o divisor pelo teclado; a proporção persiste', () => {
  test('←/→/Home/End mudam a proporção e ela vai para layout.preview; reabrir mantém', async () => {
    const h = await openApp({
      'a.md': A,
      [CONFIG_PATH]: '{"layout":{"split":{"x":1}},"outra":2}',
    });
    pressToggle();
    const separator = screen.getByRole('separator', { name: 'Redimensionar editor e prévia' });
    expect(separator.getAttribute('aria-valuetext')).toBe('Editor 50%, prévia 50%');
    fireEvent.keyDown(separator, { key: 'ArrowRight' });
    fireEvent.keyDown(separator, { key: 'ArrowRight', shiftKey: true });
    expect(h.app.store.getState().layoutPreview.ratio).toBe(0.62);
    expect(separator.getAttribute('aria-valuetext')).toBe('Editor 62%, prévia 38%');
    fireEvent.keyDown(separator, { key: 'End' });
    fireEvent.keyDown(separator, { key: 'ArrowLeft' });
    expect(h.app.store.getState().layoutPreview.ratio).toBe(0.88);
    await act(async () => {
      await vi.waitFor(
        () =>
          expect(JSON.parse(h.port.readText(CONFIG_PATH) ?? '{}')).toEqual({
            layout: { split: { x: 1 }, preview: { open: true, ratio: 0.88 } },
            outra: 2,
            theme: 'simplemd-light',
            editor: expect.any(Object),
          }),
        { timeout: 3000 },
      );
    });

    const again = await setup({ 'a.md': A, [CONFIG_PATH]: h.port.readText(CONFIG_PATH) ?? '' });
    expect(again.app.store.getState().layoutPreview).toEqual({ open: true, ratio: 0.88 });
  });
});

describe('AC-R38-3: HTML perigoso não executa na prévia do app', () => {
  test('html.md do FX-R7: nada ativo no host, `__xss` indefinido, a nota intacta', async () => {
    const files = Object.fromEntries(
      Object.entries(fxR7()).filter(([path]) => path.endsWith('.md')),
    ) as Record<string, string>;
    const h = await openApp(files, 'html.md');
    pressToggle();
    await waitReady(h);
    const el = host();
    expect(el?.querySelector('details summary')?.textContent).toBe('Resumo');
    expect(
      el?.querySelectorAll('script, iframe, object, embed, form, input, style, link, meta, base'),
    ).toHaveLength(0);
    const handlers = [...(el?.querySelectorAll('*') ?? [])].flatMap((node) =>
      [...node.attributes].filter((attr) => /^on/i.test(attr.name)).map((attr) => attr.name),
    );
    expect(handlers).toEqual([]);
    expect(Reflect.get(window, '__xss')).toBeUndefined();
    expect(el?.querySelector(`.${PREVIEW_REFUSED_CLASS}`)).toBeNull();
    expect(h.text('html.md')).toBe(files['html.md']);
  });

  test('fórmula gigante: o KaTeX limita os tamanhos a 50 em (maxSize, F7 da r38a)', async () => {
    const h = await openApp(
      { 'f.md': '# F\n\n$$\n\\rule{5000em}{5000em}\n$$\n\n$\\kern 9999em x$\n' },
      'f.md',
    );
    pressToggle();
    await waitReady(h);
    const sizes = [...(host()?.querySelectorAll<HTMLElement>('.katex [style]') ?? [])].flatMap(
      (el) => [...el.style.cssText.matchAll(/(-?[\d.]+)em/g)].map((match) => Number(match[1])),
    );
    expect(sizes.length).toBeGreaterThan(0);
    // O teto é alcançado (sem `maxSize`, a regra sai com 5000 em e o kern com 9999 em).
    expect(sizes.map(Math.abs)).toContain(50);
    expect(Math.max(...sizes.map(Math.abs))).toBeLessThanOrEqual(50);
  });

  test('bloco recusado: o aviso fica no lugar dele e a região de status diz quantos', async () => {
    const h = await openApp();
    forced.blocks = [
      { line: 1, html: '<h1>Título</h1>' },
      { line: 3, html: '<p onclick="window.__xss = 1">ativo</p>' },
      { line: 5, html: '<p>fim</p>' },
    ];
    pressToggle();
    await waitReady(h);
    const notices = [...(host()?.querySelectorAll(`.${PREVIEW_REFUSED_CLASS}`) ?? [])];
    expect(notices.map((n) => n.closest('[data-line]')?.getAttribute('data-line'))).toEqual(['3']);
    expect(notices[0]?.textContent).toBe(
      'Bloco não exibido na prévia: conteúdo recusado por segurança.',
    );
    expect(host()?.querySelector('h1')?.textContent).toBe('Título');
    const status = screen.getByTestId('preview-status');
    expect(status.getAttribute('role')).toBe('status');
    expect(status.textContent).toBe(
      '1 bloco não exibido na prévia: conteúdo recusado por segurança.',
    );
    expect(host()?.querySelector('[onclick]')).toBeNull();
    expect(Reflect.get(window, '__xss')).toBeUndefined();
  });
});

describe('layout.preview no config.json (no molde de appearance.explorer)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  });

  const sha = (h: Harness) =>
    createHash('sha256')
      .update(h.port.readBytes(CONFIG_PATH) ?? new Uint8Array())
      .digest('hex');
  const fieldNotices = (h: Harness) =>
    h.app.store.getState().notices.filter((n) => n.notice === 'config-field');

  test('sem a seção: fechada a 50 %, sem aviso, sem gravar; válida é lida e não regravada', async () => {
    const plain = await setup({ 'a.md': A, [CONFIG_PATH]: '{"x":1}' });
    expect(plain.app.store.getState().layoutPreview).toEqual({ open: false, ratio: 0.5 });
    expect(fieldNotices(plain)).toEqual([]);
    const valid = await setup({
      'a.md': A,
      [CONFIG_PATH]: '{"layout":{"preview":{"open":true,"ratio":0.3}}}',
    });
    expect(valid.app.store.getState().layoutPreview).toEqual({ open: true, ratio: 0.3 });
    await vi.advanceTimersByTimeAsync(PREFS_SAVE_DEBOUNCE_MS * 5);
    expect(plain.writes() + valid.writes()).toBe(0);
  });

  test('inválido: padrão do campo + 1 aviso config-field com os nomes; o arquivo não muda', async () => {
    for (const [config, detail] of [
      [
        '{"layout":{"preview":{"open":"sim","ratio":2}}}',
        'layout.preview.open, layout.preview.ratio',
      ],
      ['{"layout":{"preview":{"ratio":0.05}}}', 'layout.preview.ratio'],
      ['{"layout":{"preview":3}}', 'layout.preview'],
      ['{"layout":[]}', 'layout'],
    ] as const) {
      const h = await setup({ 'a.md': A, [CONFIG_PATH]: config });
      const before = sha(h);
      expect(h.app.store.getState().layoutPreview).toEqual({ open: false, ratio: 0.5 });
      expect(fieldNotices(h).map((n) => n.detail)).toEqual([detail]);
      await vi.advanceTimersByTimeAsync(PREFS_SAVE_DEBOUNCE_MS * 5);
      expect(h.writes()).toBe(0);
      expect(sha(h)).toBe(before);
    }
  });

  test('gravação por outra causa não toca layout; a escolha grava as 2 chaves e preserva o resto', async () => {
    const config = '{"layout":{"split":{"y":2},"preview":{"open":"sim","extra":1}}}';
    const h = await setup({ 'a.md': A, [CONFIG_PATH]: config });
    h.app.settings.setTheme('simplemd-dark');
    await vi.advanceTimersByTimeAsync(PREFS_SAVE_DEBOUNCE_MS);
    expect(JSON.parse(h.port.readText(CONFIG_PATH) ?? '{}').layout).toEqual({
      split: { y: 2 },
      preview: { open: 'sim', extra: 1 },
    });

    h.app.settings.setPreviewLayout({ open: true });
    h.app.settings.setPreviewLayout({ ratio: 0.95 });
    expect(h.app.store.getState().layoutPreview).toEqual({ open: true, ratio: 0.9 });
    await vi.advanceTimersByTimeAsync(PREFS_SAVE_DEBOUNCE_MS);
    expect(JSON.parse(h.port.readText(CONFIG_PATH) ?? '{}').layout).toEqual({
      split: { y: 2 },
      preview: { open: true, ratio: 0.9, extra: 1 },
    });
    // Igual não grava de novo; NaN é ignorado.
    const writes = h.writes();
    h.app.settings.setPreviewLayout({ open: true, ratio: Number.NaN });
    await vi.advanceTimersByTimeAsync(PREFS_SAVE_DEBOUNCE_MS * 5);
    expect(h.writes()).toBe(writes);
  });

  test('sem pasta: a escolha vale só na sessão (nada é gravado)', async () => {
    const h = await setup({ 'a.md': A }, { open: false });
    h.app.settings.setPreviewLayout({ open: true, ratio: 0.4 });
    expect(h.app.store.getState().layoutPreview).toEqual({ open: true, ratio: 0.4 });
    await vi.advanceTimersByTimeAsync(PREFS_SAVE_DEBOUNCE_MS * 5);
    expect(h.writes()).toBe(0);
  });
});
