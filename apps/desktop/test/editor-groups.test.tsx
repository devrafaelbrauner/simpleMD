// @vitest-environment jsdom
import '../../../packages/core/test/setup-dom';
import { EditorView } from '@codemirror/view';
import { builtinHotkeys, normalizeHotkey } from '@simplemd/plugin-api/runtime';
import { editorViewConstructions } from '@simplemd/ui';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { App } from '../src/app/App';
import { GROUP_TEXT } from '../src/app/EditorGroup';
import { matchGlobalKey, TOGGLE_SPLIT_KEY } from '../src/app/global-keys';
import { SIDE_PREVIEW_TEXT } from '../src/app/useBuiltinCommands';
import { setup, type Harness } from './helpers';

/**
 * r39b (design-r39 §1, §6): os dois grupos do editor no app real. AC-R39-1: duas notas editáveis
 * lado a lado, cada uma gravando só no próprio arquivo; dividir cria 1 `EditorView`, trocar de aba
 * e juntar criam 0. AC-R39-2: comandos, ⌘E, IA, ⌘W e Ctrl-Tab agem no grupo com foco; ×, ⌘W no
 * grupo vazio e a última aba juntam no outro grupo; 640 px para dividir e 960 para a prévia.
 */
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const A = '# A\n\n- [ ] tarefa A\n\n|a|b|\n|-|-|\n|1|2|\n';
const B = '# B\n\n- [ ] tarefa B\n\n|a|b|\n|-|-|\n|1|2|\n';
const FILES = { 'a.md': A, 'b.md': B, 'c.md': '# C\n', 'd.md': '# D\n' };

/** Tecla na captura da janela (o jsdom não é macOS: `Mod` = Ctrl). */
function press(key: string, init: KeyboardEventInit, target: Element = document.body) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}
const pressSplit = (target?: Element) => press('\\', { code: 'Backslash', ctrlKey: true }, target);

const group = (index: 0 | 1) =>
  document.querySelector<HTMLElement>(`[data-testid="editor-group"][data-group="${index}"]`);

/** O EditorView montado no grupo (o do DOM, não o do montador). */
function viewOf(index: 0 | 1): EditorView {
  const dom = group(index)?.querySelector<HTMLElement>('.cm-editor');
  const view = dom ? EditorView.findFromDOM(dom) : null;
  if (!view) throw new Error(`grupo ${index} sem editor`);
  return view;
}

/** Abas do grupo na ordem da faixa; `*` = a ativa. */
const tabsOf = (index: 0 | 1) =>
  [...(group(index)?.querySelectorAll<HTMLElement>('[role="tab"]') ?? [])].map(
    (tab) => `${tab.dataset.tabId}${tab.getAttribute('aria-selected') === 'true' ? '*' : ''}`,
  );

const announced = (index: 0 | 1) => viewOf(index).dom.querySelector('.cm-announced')?.textContent;

async function open(h: Harness, path: string): Promise<void> {
  await act(async () => {
    await h.app.sync.openFile(path);
  });
}

/** O app com `a.md` aberta; com `right`, o editor dividido e essas notas à direita (a última ativa). */
async function openApp(right: readonly string[] = []) {
  // O explorador virtualizado só desenha as linhas que cabem na altura (o jsdom mede 0).
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600);
  const h = await setup(FILES);
  render(<App app={h.app} />);
  await open(h, 'a.md');
  if (right.length > 0) {
    pressSplit(viewOf(0).contentDOM);
    for (const path of right) await open(h, path);
  }
  return h;
}

/** O foco e o anúncio do ⌘\ vêm no quadro seguinte. */
async function nextFrame(): Promise<void> {
  await act(async () => {
    const { promise, resolve } = Promise.withResolvers<void>();
    requestAnimationFrame(() => resolve());
    await promise;
  });
}

const writtenPaths = (h: Harness) =>
  h.port
    .calls()
    .filter((call) => call.op === 'writeFile')
    .map((call) => call.abs.replace(/^\/vault\//, ''));

describe('AC-R39-1: duas notas editáveis lado a lado; trocar de aba no grupo cria 0 views', () => {
  test('sem divisão: um grupo, a faixa "Arquivos abertos" e nada de grupo nem de "Fechar grupo"', async () => {
    const h = await openApp();
    expect(document.querySelectorAll('[data-testid="editor-group"]')).toHaveLength(1);
    expect(group(0)?.getAttribute('role')).toBeNull();
    expect(group(0)?.hasAttribute('aria-label')).toBe(false);
    expect(group(0)?.hasAttribute('data-focus')).toBe(false);
    screen.getByRole('tablist', { name: 'Arquivos abertos' });
    expect(screen.queryByTestId('group-close')).toBeNull();
    expect(document.querySelector('.smd-tabbar')).toBeNull();
    expect(screen.getByRole('tab', { name: 'a.md' }).id).toBe('tab-0');
    expect(screen.getByRole('tabpanel').id).toBe('editor-panel');
    expect(h.app.plugins.editor.view).toBe(viewOf(0));
  });

  test('⌘\\ divide: direita vazia com o foco, explorador focado com o anúncio, 1 EditorView novo', async () => {
    const h = await openApp();
    const left = viewOf(0);
    const before = editorViewConstructions();
    expect(pressSplit(left.contentDOM).defaultPrevented).toBe(true);
    const s = h.app.store.getState();
    expect([s.split, s.focusedGroup, s.activeId, s.groupActive]).toEqual([
      true,
      1,
      null,
      ['a.md', null],
    ]);
    expect(editorViewConstructions() - before).toBe(1);
    // O grupo 0 é o mesmo nó e o mesmo view; o novo vem depois dele.
    expect(viewOf(0)).toBe(left);
    expect(group(0)?.nextElementSibling).toBe(group(1));
    const right = within(screen.getByRole('group', { name: 'Grupo da direita' }));
    right.getByText('Grupo vazio');
    right.getByText('Escolha uma nota no explorador para abrir aqui.');
    expect(right.getByText('junta os grupos').querySelector('kbd')?.textContent).toBe('Ctrl+\\');
    right.getByRole('button', { name: 'Fechar grupo da direita' });
    expect(right.queryByRole('tablist')).toBeNull();
    const leftGroup = within(screen.getByRole('group', { name: 'Grupo da esquerda' }));
    leftGroup.getByRole('tablist', { name: 'Arquivos abertos, grupo da esquerda' });
    leftGroup.getByRole('button', { name: 'Fechar grupo da esquerda' });
    // Sem foco, a aba ativa da esquerda perde a faixa e o negrito (CSS por `data-focus`).
    expect(group(0)?.dataset.focus).toBe('off');
    expect(group(1)?.hasAttribute('data-focus')).toBe(false);

    await nextFrame();
    expect(document.activeElement?.getAttribute('data-testid')).toBe('explorer-row');
    // r39c: pelo canal de anúncios do app (o editor com foco), não pela região do explorador.
    expect(announced(1)).toBe(GROUP_TEXT.divided);
    expect(h.app.store.getState().explorerLive).toBe('');
    expect(h.app.store.getState().focusedGroup).toBe(1);
  });

  test('cada grupo grava só a própria nota; abas no grupo e a junção não criam view; cursor fica', async () => {
    const h = await openApp(['b.md']);
    const left = viewOf(0);
    const right = viewOf(1);
    const views = editorViewConstructions();
    expect(left.state.doc.toString()).toBe(A);
    expect(right.state.doc.toString()).toBe(B);
    const tabB = screen.getByRole('tab', { name: 'b.md' });
    expect([tabB.id, tabB.getAttribute('aria-controls')]).toEqual(['tab-2-0', 'editor-panel-2']);
    expect(within(group(1)!).getByRole('tabpanel').getAttribute('aria-labelledby')).toBe('tab-2-0');

    // Digitar nos dois: cada aba grava no próprio arquivo (autosave por aba).
    act(() => left.dispatch({ changes: { from: left.state.doc.length, insert: 'esquerda\n' } }));
    act(() => right.dispatch({ changes: { from: right.state.doc.length, insert: 'direita\n' } }));
    await act(async () => {
      await h.app.sync.flushAll();
    });
    expect(h.port.readText('a.md')).toBe(`${A}esquerda\n`);
    expect(h.port.readText('b.md')).toBe(`${B}direita\n`);
    expect(new Set(writtenPaths(h))).toEqual(new Set(['a.md', 'b.md']));

    // Trocar de aba dentro do grupo da direita: o mesmo view.
    await open(h, 'c.md');
    expect(tabsOf(1)).toEqual(['b.md', 'c.md*']);
    expect(viewOf(1)).toBe(right);
    expect(right.state.doc.toString()).toBe('# C\n');
    act(() => h.app.store.getState().activate('b.md'));
    expect(right.state.doc.toString()).toBe(`${B}direita\n`);
    act(() => right.dispatch({ selection: { anchor: 4 } }));
    expect(editorViewConstructions()).toBe(views);

    // Juntar com o foco à direita: as abas dela primeiro, a nota vem com o cursor, 0 views.
    pressSplit(right.contentDOM);
    expect(announced(0)).toBe(GROUP_TEXT.joined);
    expect(group(1)).toBeNull();
    expect(tabsOf(0)).toEqual(['b.md*', 'c.md', 'a.md']);
    expect(viewOf(0)).toBe(left);
    expect(left.state.doc.toString()).toBe(`${B}direita\n`);
    expect(left.state.selection.main.head).toBe(4);
    expect(editorViewConstructions()).toBe(views);
    expect(group(0)?.getAttribute('role')).toBeNull();
    screen.getByRole('tablist', { name: 'Arquivos abertos' });
    await nextFrame();
    expect(document.activeElement).toBe(left.contentDOM);
  });

  test('nota já aberta no outro grupo: o explorador foca o grupo dela, sem aba nova', async () => {
    const h = await openApp(['b.md']);
    act(() => viewOf(0).focus());
    expect(h.app.store.getState().focusedGroup).toBe(0);
    expect(group(1)?.dataset.focus).toBe('off');
    fireEvent.click(screen.getByRole('treeitem', { name: 'b.md' }));
    await act(async () => {
      await vi.waitFor(() => expect(document.activeElement).toBe(viewOf(1).contentDOM));
    });
    expect(h.app.store.getState().focusedGroup).toBe(1);
    expect(tabsOf(0)).toEqual(['a.md*']);
    expect(tabsOf(1)).toEqual(['b.md*']);
  });
});

describe('r39c: resíduos dos grupos (foco, anúncios, estado guardado)', () => {
  test('AC-R39C-4: a devolução de foco da paleta antes do quadro não tira o grupo novo; a nota abre nele', async () => {
    const h = await openApp();
    act(() => {
      void h.app.plugins.commands.get('editor:toggle-split')?.run();
    });
    // A paleta fechando devolve o foco ao editor da esquerda antes do quadro do ⌘\.
    act(() => viewOf(0).focus());
    expect(h.app.store.getState().focusedGroup).toBe(0);
    await nextFrame();
    expect(h.app.store.getState().focusedGroup).toBe(1);
    fireEvent.click(screen.getByRole('treeitem', { name: 'b.md' }));
    await act(async () => {
      await vi.waitFor(() => expect(tabsOf(1)).toEqual(['b.md*']));
    });
    expect(tabsOf(0)).toEqual(['a.md*']);
    // A ida e volta no mesmo quadro não anuncia troca de grupo.
    await nextFrame();
    expect(announced(0)).not.toBe(GROUP_TEXT.focused[0]);
  });

  test('AC-R39C-4: ⌘\\ e ⌘W no mesmo quadro ficam juntos, sem o anúncio de dividido depois', async () => {
    const h = await openApp();
    pressSplit(viewOf(0).contentDOM);
    expect(press('w', { ctrlKey: true }).defaultPrevented).toBe(true);
    expect(h.app.store.getState().split).toBe(false);
    await nextFrame();
    expect(h.app.store.getState().split).toBe(false);
    expect(h.app.store.getState().focusedGroup).toBe(0);
    expect(announced(0)).toBe(GROUP_TEXT.joined);
    expect(document.activeElement?.getAttribute('data-testid')).not.toBe('explorer-row');
  });

  test('a troca do grupo com foco anuncia pelo canal do app, uma vez, no editor do grupo novo', async () => {
    await openApp(['b.md']);
    // r39d: o quadro do ⌘\ (que devolve o foco ao grupo novo) roda antes da troca de grupo.
    await nextFrame();
    const spoken = vi.spyOn(EditorView.announce, 'of');
    act(() => viewOf(0).focus());
    await nextFrame();
    expect(announced(0)).toBe(GROUP_TEXT.focused[0]);
    // A ida e volta no mesmo quadro não fala.
    act(() => {
      viewOf(1).focus();
      viewOf(0).focus();
    });
    await nextFrame();
    act(() => viewOf(1).focus());
    await nextFrame();
    expect(announced(1)).toBe(GROUP_TEXT.focused[1]);
    expect(spoken.mock.calls.map(([text]) => text)).toEqual(GROUP_TEXT.focused);
  });

  test('AC-R39C-2: aba fechada sem voltar à tela, última aba do grupo e troca de pasta não guardam estado', async () => {
    const h = await openApp(['b.md', 'c.md']);
    const { editor } = h.app.plugins;
    const stateOf = (path: string) => {
      const record = h.app.registry.get(path);
      if (!record) throw new Error(`sem registro: ${path}`);
      return record.state;
    };
    // × da direita: c.md (mostrada lá) vai para o fim da esquerda sem aparecer.
    const c = stateOf('c.md');
    fireEvent.click(screen.getByRole('button', { name: 'Fechar grupo da direita' }));
    expect(tabsOf(0)).toEqual(['a.md*', 'b.md', 'c.md']);
    await act(async () => {
      await h.app.sync.closeTab('c.md');
    });
    expect(editor.takeParked('c.md', c)).toBeNull();

    // Última aba do grupo da direita: o grupo fecha com a aba, nada fica guardado dela.
    pressSplit(viewOf(0).contentDOM);
    await open(h, 'd.md');
    const d = stateOf('d.md');
    press('w', { ctrlKey: true }, viewOf(1).contentDOM);
    await act(async () => {
      await vi.waitFor(() => expect(h.app.store.getState().split).toBe(false));
    });
    expect(editor.takeParked('d.md', d)).toBeNull();

    // Troca de pasta com uma nota guardada pela junção (c.md, de novo, mostrada à direita).
    pressSplit(viewOf(0).contentDOM);
    await open(h, 'c.md');
    expect(tabsOf(1)).toEqual(['c.md*']);
    const reopened = stateOf('c.md');
    fireEvent.click(screen.getByRole('button', { name: 'Fechar grupo da direita' }));
    expect(tabsOf(0)).toEqual(['a.md*', 'b.md', 'c.md']);
    await act(async () => {
      await h.app.sync.openVault('shell');
    });
    expect(h.app.store.getState().tabs).toEqual([]);
    expect(editor.takeParked('c.md', reopened)).toBeNull();
  });
});

describe('AC-R39-2: comandos e IA agem no grupo com foco', () => {
  test('tarefa, tabela e ⌘E só no grupo com foco; o modo da barra segue o foco; juntar leva o modo', async () => {
    const h = await openApp(['b.md']);
    const { commands } = h.app.plugins;
    const right = viewOf(1);
    act(() => right.dispatch({ selection: { anchor: B.indexOf('tarefa B') } }));
    act(() => {
      void commands.get('task:toggle')?.run();
    });
    act(() => right.dispatch({ selection: { anchor: right.state.doc.toString().indexOf('|a|') } }));
    act(() => {
      void commands.get('table:format-all')?.run();
    });
    expect(right.state.doc.toString()).toContain('- [x] tarefa B');
    expect(right.state.doc.toString()).toContain('| a ');
    expect(right.state.doc.toString()).not.toContain('|a|b|');
    expect(viewOf(0).state.doc.toString()).toBe(A);

    const mode = (index: 0 | 1) => viewOf(index).dom.getAttribute('data-smd-mode');
    expect([mode(0), mode(1)]).toEqual(['source', 'source']);
    expect(press('e', { ctrlKey: true }, viewOf(1).contentDOM).defaultPrevented).toBe(true);
    expect([mode(0), mode(1)]).toEqual(['source', 'live']);
    expect(h.app.plugins.editor.mode.getSnapshot()).toBe('live');
    act(() => viewOf(0).focus());
    expect(h.app.store.getState().focusedGroup).toBe(0);
    expect(h.app.plugins.editor.mode.getSnapshot()).toBe('source');
    // Juntar no grupo da direita: a nota dela chega ao view que fica no modo em que estava.
    act(() => viewOf(1).focus());
    pressSplit(viewOf(1).contentDOM);
    expect(tabsOf(0)).toEqual(['b.md*', 'a.md']);
    expect(mode(0)).toBe('live');
    expect(h.app.plugins.editor.mode.getSnapshot()).toBe('live');
  });

  test('IA: o cartão vale para o grupo da nota; com o foco no outro, "Volte para a aba"', async () => {
    const h = await openApp(['b.md']);
    h.app.settings.setAi({ provider: 'ollama', models: { ollama: 'qwen3.5:9b' } });
    const right = viewOf(1);
    act(() => right.dispatch({ selection: { anchor: 2, head: 3 } }));
    act(() => {
      void h.app.plugins.commands.get('ai:summarize')?.run();
    });
    await act(async () => {
      await vi.waitFor(() => expect(h.app.ai.getSnapshot().card?.status).toBe('done'));
    });
    expect(h.app.ai.getSnapshot().card?.tabId).toBe('b.md');
    act(() => viewOf(0).focus());
    expect(h.app.ai.cardBlock('replace')).toBe('Volte para a aba “b.md” para aplicar.');
    expect(h.app.ai.replaceSelection()).toBe(false);
    act(() => right.focus());
    let replaced = false;
    act(() => {
      replaced = h.app.ai.replaceSelection();
    });
    expect(replaced).toBe(true);
    expect(right.state.doc.toString()).not.toBe(B);
    expect(right.state.doc.toString().endsWith('- [ ] tarefa B\n\n|a|b|\n|-|-|\n|1|2|\n')).toBe(
      true,
    );
    expect(viewOf(0).state.doc.toString()).toBe(A);
  });

  test('⌘W fecha a aba do grupo com foco; Ctrl-Tab anda só nele; ⌘W no grupo vazio fecha o grupo', async () => {
    const h = await openApp(['b.md', 'c.md']);
    const right = viewOf(1);
    press('Tab', { ctrlKey: true }, right.contentDOM);
    expect(tabsOf(1)).toEqual(['b.md*', 'c.md']);
    press('Tab', { ctrlKey: true, shiftKey: true }, right.contentDOM);
    expect(tabsOf(1)).toEqual(['b.md', 'c.md*']);
    expect(tabsOf(0)).toEqual(['a.md*']);
    press('w', { ctrlKey: true }, right.contentDOM);
    await act(async () => {
      await vi.waitFor(() => expect(tabsOf(1)).toEqual(['b.md*']));
    });
    expect(tabsOf(0)).toEqual(['a.md*']);

    // Juntar e dividir de novo: a direita vazia e com o foco. Ctrl-Tab não tem para onde ir (segue
    // adiante); ⌘W fecha o grupo vazio e as abas ficam na esquerda.
    pressSplit(right.contentDOM);
    pressSplit(viewOf(0).contentDOM);
    expect(tabsOf(1)).toEqual([]);
    expect(press('Tab', { ctrlKey: true }).defaultPrevented).toBe(false);
    expect(press('w', { ctrlKey: true }).defaultPrevented).toBe(true);
    expect(h.app.store.getState().split).toBe(false);
    expect(announced(0)).toBe(GROUP_TEXT.joined);
    expect(tabsOf(0)).toEqual(['b.md*', 'a.md']);
  });

  test('× "Fechar grupo" e a última aba do grupo juntam no outro, com as abas no fim e o anúncio', async () => {
    const h = await openApp(['b.md', 'c.md']);
    // × da direita: fica a esquerda, com as abas da direita no fim.
    fireEvent.click(screen.getByRole('button', { name: 'Fechar grupo da direita' }));
    expect(h.app.store.getState().split).toBe(false);
    expect(tabsOf(0)).toEqual(['a.md*', 'b.md', 'c.md']);
    expect(announced(0)).toBe(GROUP_TEXT.joined);

    // × da esquerda: fica a direita, que passa a ser o grupo 0 com as abas dela primeiro.
    pressSplit(viewOf(0).contentDOM);
    await open(h, 'd.md');
    fireEvent.click(screen.getByRole('button', { name: 'Fechar grupo da esquerda' }));
    expect(h.app.store.getState().split).toBe(false);
    expect(tabsOf(0)).toEqual(['d.md*', 'a.md', 'b.md', 'c.md']);

    // Fechar a última aba do grupo da direita fecha o grupo (store) e o editor anuncia.
    await act(async () => {
      await h.app.sync.closeTab('c.md');
    });
    pressSplit(viewOf(0).contentDOM);
    await open(h, 'c.md');
    expect(tabsOf(1)).toEqual(['c.md*']);
    press('w', { ctrlKey: true }, viewOf(1).contentDOM);
    await act(async () => {
      await vi.waitFor(() => expect(h.app.store.getState().split).toBe(false));
    });
    expect(tabsOf(0)).toEqual(['d.md*', 'a.md', 'b.md']);
    expect(announced(0)).toBe(GROUP_TEXT.joined);
  });
});

describe('640 px para dividir; 960 para a prévia com o editor dividido', () => {
  test('estreito: comando desabilitado com a largura, a tecla avisa e não divide', async () => {
    const h = await openApp();
    const command = h.app.plugins.commands.get('editor:toggle-split');
    act(() => h.app.store.setState({ editorWidth: 528 }));
    const reason =
      'Precisa de 640 px no editor (agora 528 px). Feche o painel lateral ou aumente a janela.';
    expect(command?.isEnabled?.()).toEqual({ reason });
    expect(pressSplit().defaultPrevented).toBe(true);
    expect(h.app.store.getState().split).toBe(false);
    expect(h.app.store.getState().notices.at(-1)).toMatchObject({
      kind: 'info',
      notice: 'split',
      text: reason,
    });
    act(() => h.app.store.setState({ editorWidth: 640 }));
    expect(command?.isEnabled?.()).toBe(true);
  });

  test('dividido: a prévia pede 960 px, esconde com o anúncio e segue o grupo com foco', async () => {
    const h = await openApp(['b.md']);
    const command = h.app.plugins.commands.get('editor:toggle-side-preview');
    act(() => h.app.store.setState({ editorWidth: 940 }));
    expect(command?.isEnabled?.()).toEqual({ reason: SIDE_PREVIEW_TEXT.narrow(940, 960) });
    act(() => h.app.store.setState({ editorWidth: 1200 }));
    act(() => {
      void command?.run();
    });
    expect(screen.getByRole('region', { name: 'Prévia — b.md' })).toBeTruthy();
    // Os dois grupos são o lado inicial do divisor da prévia.
    expect(screen.getByRole('separator').previousElementSibling?.contains(group(1))).toBe(true);
    act(() => viewOf(0).focus());
    expect(screen.getByRole('region', { name: 'Prévia — a.md' })).toBeTruthy();
    act(() => h.app.store.setState({ editorWidth: 950 }));
    expect(screen.queryByTestId('preview-pane')).toBeNull();
    expect(announced(0)).toBe('Prévia lado a lado escondida: o editor tem 950 px (mínimo 960).');
    // Juntar devolve a prévia (900 px bastam com um grupo só).
    pressSplit(viewOf(0).contentDOM);
    expect(screen.getByRole('region', { name: 'Prévia — a.md' })).toBeTruthy();
  });
});

describe('comando e atalho (D-R39-05)', () => {
  test('"Dividir editor" / "Juntar grupos do editor" com Ctrl+\\; sem nota, o motivo; modal bloqueia', async () => {
    const h = await setup(FILES);
    render(<App app={h.app} />);
    const command = () => h.app.plugins.commands.get('editor:toggle-split');
    expect(command()?.title).toBe('Dividir editor');
    expect(command()?.hotkey).toBe(TOGGLE_SPLIT_KEY);
    expect(command()?.isEnabled?.()).toEqual({ reason: 'Abra uma nota primeiro.' });
    expect(pressSplit().defaultPrevented).toBe(true);
    expect(h.app.store.getState().notices.at(-1)?.text).toBe('Abra uma nota primeiro.');

    await open(h, 'a.md');
    act(() => {
      void command()?.run();
    });
    expect(h.app.store.getState().split).toBe(true);
    expect(command()?.title).toBe('Juntar grupos do editor');
    expect(command()?.isEnabled?.()).toBe(true);
    // Sob um modal a tecla não age (e não chega ao WebView).
    act(() => h.app.store.setState({ settingsOpen: true }));
    expect(pressSplit().defaultPrevented).toBe(true);
    expect(h.app.store.getState().split).toBe(true);
    act(() => h.app.store.setState({ settingsOpen: false }));
    act(() => {
      void command()?.run();
    });
    expect(h.app.store.getState().split).toBe(false);
    expect(command()?.title).toBe('Dividir editor');

    // Classe A: ⌘\ no macOS, Ctrl+\ nos demais; reservado para plugins.
    const key = { metaKey: false, ctrlKey: false, altKey: false, shiftKey: false };
    expect(matchGlobalKey({ ...key, key: '\\', metaKey: true }, 'mac')).toBe('toggle-split');
    expect(matchGlobalKey({ ...key, key: '\\', ctrlKey: true }, 'other')).toBe('toggle-split');
    expect(matchGlobalKey({ ...key, key: '\\', ctrlKey: true, altKey: true }, 'other')).toBe(null);
    for (const platform of ['mac', 'other'] as const)
      expect(builtinHotkeys([], platform).has(normalizeHotkey('Mod-\\', platform))).toBe(true);
  });
});
