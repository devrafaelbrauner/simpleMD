import { createHash } from 'node:crypto';
import { EditorState, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { getCM, Vim } from '@replit/codemirror-vim';
import { createMarkdownExtensions } from '@simplemd/core';
import type { PluginAPI } from '@simplemd/plugin-api';
import type { InternalHostContext, VimStatus } from '@simplemd/plugin-api/internal/host';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createVimPlugin, SILENT_EX_COMMANDS } from '../src/vim/index';
import { translateVimMessage } from '../src/vim/messages';
import {
  createModeReporter,
  MODE_ANNOUNCE_DELAY_MS,
  modeAnnouncement,
  modeFromEvent,
  modeFromState,
} from '../src/vim/modes';
import { localizeNotification, localizePrompt, PROMPT_LABELS } from '../src/vim/panel';

/**
 * r7 S4 — plugin `simplemd.vim` (I-4): funções da biblioteca no editor do simpleMD (AC-I4.2),
 * comandos ex sem efeito (D-44), indicador e anúncio do modo (R-I4.3, AC-I4.5 parte VT), painel W6
 * em pt-BR (STR-160/161, A-44). Teclas por `keydown` real no `contentDOM` (o caminho do navegador);
 * texto do modo inserção por transação `input.type` (o jsdom não insere texto por tecla).
 */

interface Mounted {
  readonly view: EditorView;
  readonly statuses: Array<VimStatus | null>;
  readonly announcements: string[];
  readonly extensions: readonly Extension[];
  readonly dispose: () => void;
}

const mounted: EditorView[] = [];
afterEach(() => {
  while (mounted.length) mounted.pop()?.destroy();
  document.body.innerHTML = '';
  vi.useRealTimers();
});

function fakeHost(statuses: Array<VimStatus | null>, announcements: string[]): InternalHostContext {
  return {
    pluginId: 'simplemd.vim',
    platform: 'other',
    editor: {
      contextAction: () => [],
      interact: () => [],
      escape: () => [],
      announce: (text) => announcements.push(text),
    },
    vimStatus: { set: (value) => statuses.push(value), clear: () => statuses.push(null) },
    options: { get: <T>() => undefined as T, subscribe: () => () => {} },
    links: { openExternal: () => {} },
  };
}

/** Editor do simpleMD (núcleo: markdown + histórico) com o plugin ativado por uma API que só grava. */
function mount(doc: string, anchor = 0): Mounted {
  const statuses: Array<VimStatus | null> = [];
  const announcements: string[] = [];
  const extensions: Extension[] = [];
  const api = {
    registerEditorExtension: (ext: { source?: Extension }) => {
      if (ext.source) extensions.push(ext.source);
    },
  } as unknown as PluginAPI;
  const dispose = createVimPlugin(fakeHost(statuses, announcements)).default(api);
  const parent = document.body.appendChild(document.createElement('div'));
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor },
      extensions: [createMarkdownExtensions(), extensions],
    }),
    parent,
  });
  mounted.push(view);
  return { view, statuses, announcements, extensions, dispose };
}

const KEY_CODES: Record<string, number> = { Escape: 27, Enter: 13 };

/** `keydown` como o navegador entrega (devolve se alguém consumiu). */
function press(
  target: HTMLElement,
  key: string,
  mods: { ctrlKey?: boolean; shiftKey?: boolean; metaKey?: boolean } = {},
): boolean {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...mods });
  const keyCode = KEY_CODES[key] ?? (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0);
  Object.defineProperty(event, 'keyCode', { value: keyCode });
  Object.defineProperty(event, 'which', { value: keyCode });
  target.dispatchEvent(event);
  return event.defaultPrevented;
}

/** Sequência de teclas no editor; `<Esc>`, `<CR>` e `<C-x>` como no Vim. */
function keys(view: EditorView, sequence: string): void {
  for (const token of sequence.match(/<[^>]+>|./gu) ?? []) {
    if (token === '<Esc>') press(view.contentDOM, 'Escape');
    else if (token === '<CR>') press(view.contentDOM, 'Enter');
    else if (/^<C-.>$/.test(token)) press(view.contentDOM, token[3]!, { ctrlKey: true });
    else press(view.contentDOM, token, { shiftKey: token !== token.toLowerCase() });
  }
}

/** Digitação no modo inserção (o texto que o navegador inseriria). */
function type(view: EditorView, text: string): void {
  view.dispatch(view.state.replaceSelection(text), { userEvent: 'input.type' });
}

/** Responde ao prompt aberto (`:` ou `/`) e confirma com Enter, no próprio input. */
function answerPrompt(view: EditorView, text: string): void {
  const input = view.dom.querySelector<HTMLInputElement>('.cm-vim-panel input');
  if (!input) throw new Error('prompt do Vim não abriu');
  input.value = text;
  press(input, 'Enter');
}

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const message = (view: EditorView) =>
  view.dom.querySelector('.cm-vim-panel [role="status"]')?.textContent ?? null;

describe('AC-I4.2 funções do Vim no editor do simpleMD (tabela de casos)', () => {
  test('dd apaga a linha; u devolve o sha256 do original (histórico do núcleo)', () => {
    const doc = 'um\ndois\ntrês\n';
    const { view } = mount(doc, 3);
    keys(view, 'dd');
    expect(view.state.doc.toString()).toBe('um\ntrês\n');
    keys(view, 'u');
    expect(sha(view.state.doc.toString())).toBe(sha(doc));
    keys(view, '<C-r>');
    expect(view.state.doc.toString()).toBe('um\ntrês\n');
  });

  test.each([
    ['3w', 'alfa beta gama delta épsilon', 0, 15],
    ['w', 'alfa beta', 0, 5],
    ['$', 'alfa beta', 0, 8],
    // j/k dependem de layout (coordenadas): cobertos no smoke do navegador, não no jsdom.
    ['2e', 'alfa beta gama', 0, 8],
    ['G', 'a\nb\nc', 0, 4],
  ] as const)('movimento %s em %j → cabeça em %i… %i', (seq, doc, anchor, head) => {
    const { view } = mount(doc, anchor);
    keys(view, seq);
    expect(view.state.selection.main.head).toBe(head);
  });

  test('ciw troca a palavra; . repete a troca na palavra seguinte', () => {
    const { view } = mount('foo bar baz', 0);
    keys(view, 'ciw');
    type(view, 'novo');
    keys(view, '<Esc>');
    expect(view.state.doc.toString()).toBe('novo bar baz');
    keys(view, 'w.');
    expect(view.state.doc.toString()).toBe('novo novo baz');
  });

  test('/termo + Enter vai à 1ª ocorrência; n à seguinte; N volta', () => {
    const { view } = mount('x termo y termo z', 0);
    keys(view, '/');
    answerPrompt(view, 'termo');
    expect(view.state.selection.main.head).toBe(2);
    keys(view, 'n');
    expect(view.state.selection.main.head).toBe(10);
    keys(view, 'N');
    expect(view.state.selection.main.head).toBe(2);
  });

  test(':s/a/b/ pelo prompt troca a 1ª ocorrência da linha', () => {
    const { view } = mount('banana\nabacate', 0);
    keys(view, ':');
    answerPrompt(view, 's/a/b/');
    expect(view.state.doc.toString()).toBe('bbnana\nabacate');
  });

  test('contagem + registrador + colar: "a2yy, G, "ap', () => {
    const { view } = mount('um\ndois\ntrês', 0);
    keys(view, '"a2yyG"ap');
    expect(view.state.doc.toString()).toBe('um\ndois\ntrês\num\ndois');
  });

  test('marca e macro: ma … `a volta; qq … q e @q repetem', () => {
    const { view } = mount('a1 a2 a3', 0);
    keys(view, 'maww`a');
    expect(view.state.selection.main.head).toBe(0);
    keys(view, 'qqxwq@q');
    expect(view.state.doc.toString()).toBe('1 2 a3');
  });

  test.each(SILENT_EX_COMMANDS.flatMap(([name, prefix]) => [prefix, name]))(
    ':%s não lança erro, muda 0 bytes e não mostra mensagem (D-44)',
    (command) => {
      const doc = '# Nota\n\ntexto\n';
      const { view } = mount(doc, 0);
      keys(view, ':');
      expect(() => answerPrompt(view, command)).not.toThrow();
      expect(sha(view.state.doc.toString())).toBe(sha(doc));
      expect(view.dom.querySelector('.cm-vim-panel')).toBeNull();
      expect(message(view)).toBeNull();
    },
  );

  test(':w, :q, :wq e :x direto pelo Vim.handleEx também ficam sem efeito', () => {
    const doc = 'abc';
    const { view } = mount(doc, 0);
    const cm = getCM(view)!;
    for (const command of ['w', 'q', 'wq', 'x']) Vim.handleEx(cm, command);
    expect(view.state.doc.toString()).toBe(doc);
    expect(message(view)).toBeNull();
  });
});

describe('indicador e anúncio do modo (R-I4.3; AC-I4.5 parte VT)', () => {
  test('i, Esc, v, V, Ctrl-V, R mostram os 6 modos no slot vim, em ordem', () => {
    const { view, statuses } = mount('linha um\nlinha dois', 0);
    expect(statuses).toEqual([{ mode: 'normal' }]);
    keys(view, 'i<Esc>v<Esc>V<Esc><C-v><Esc>R<Esc>');
    expect(statuses.map((s) => s?.mode)).toEqual([
      'normal',
      'insert',
      'normal',
      'visual',
      'normal',
      'visual-line',
      'normal',
      'visual-block',
      'normal',
      'replace',
      'normal',
    ]);
  });

  test('anúncio 300 ms depois da última mudança, 1× por mudança, nunca ao ligar', () => {
    vi.useFakeTimers();
    const { view, announcements } = mount('abc', 0);
    vi.advanceTimersByTime(1000);
    expect(announcements).toEqual([]);
    keys(view, 'i');
    vi.advanceTimersByTime(MODE_ANNOUNCE_DELAY_MS - 1);
    expect(announcements).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(announcements).toEqual(['Modo Vim: inserção']);
    // Sequência rápida: só o último modo é anunciado.
    keys(view, '<Esc>v');
    vi.advanceTimersByTime(MODE_ANNOUNCE_DELAY_MS);
    expect(announcements).toEqual(['Modo Vim: inserção', 'Modo Vim: visual']);
    // Ida e volta dentro da espera: o modo final é o já anunciado, nada novo.
    keys(view, 'V<C-v>');
    keys(view, 'v');
    vi.advanceTimersByTime(MODE_ANNOUNCE_DELAY_MS * 3);
    expect(announcements).toHaveLength(2);
  });

  test('textos do anúncio (STR-160, minúsculas) e mapeamento de evento/estado', () => {
    expect(
      (['normal', 'insert', 'visual', 'visual-line', 'visual-block', 'replace'] as const).map(
        modeAnnouncement,
      ),
    ).toEqual([
      'Modo Vim: normal',
      'Modo Vim: inserção',
      'Modo Vim: visual',
      'Modo Vim: visual linha',
      'Modo Vim: visual bloco',
      'Modo Vim: substituir',
    ]);
    expect(modeFromEvent({ mode: 'visual', subMode: 'blockwise' })).toBe('visual-block');
    expect(modeFromEvent({ mode: 'outro' })).toBeNull();
    expect(modeFromState(null, false)).toBe('normal');
    expect(modeFromState({ insertMode: true }, true)).toBe('replace');
    expect(modeFromState({ visualMode: true, visualLine: true }, false)).toBe('visual-line');
    expect(modeFromState({ visualMode: true, visualBlock: true }, false)).toBe('visual-block');
    expect(modeFromState({ visualMode: true }, false)).toBe('visual');
  });

  test('desligar: indicador limpo, anúncio pendente cancelado, relatos depois ignorados', () => {
    vi.useFakeTimers();
    const statuses: Array<VimStatus | null> = [];
    const announce = vi.fn();
    const reporter = createModeReporter({
      status: { set: (v) => statuses.push(v), clear: () => statuses.push(null) },
      announce,
    });
    reporter.report('insert');
    reporter.dispose();
    reporter.report('visual');
    vi.advanceTimersByTime(MODE_ANNOUNCE_DELAY_MS * 2);
    expect(statuses).toEqual([{ mode: 'insert' }, null]);
    expect(announce).not.toHaveBeenCalled();
  });

  test('troca de estado (aba) recria o Vim em normal; desligar (descarte do activate) limpa o slot', () => {
    const { view, statuses, extensions, dispose } = mount('abc', 0);
    keys(view, 'i');
    expect(statuses.at(-1)).toEqual({ mode: 'insert' });
    view.setState(
      EditorState.create({ doc: 'xyz', extensions: [createMarkdownExtensions(), extensions] }),
    );
    expect(statuses.at(-1)).toEqual({ mode: 'normal' });
    keys(view, 'x');
    expect(view.state.doc.toString()).toBe('yz');
    dispose();
    expect(statuses.at(-1)).toBeNull();
  });
});

describe('painel W6 em pt-BR (STR-160, STR-161, A-44)', () => {
  test('":" abre o input "Comando do Vim"; "/" abre "Buscar no Vim"; Esc devolve o foco', () => {
    const { view } = mount('abc', 0);
    view.focus();
    keys(view, ':');
    const command = view.dom.querySelector<HTMLInputElement>('.cm-vim-panel input')!;
    expect(command.getAttribute('aria-label')).toBe('Comando do Vim');
    expect(document.activeElement).toBe(command);
    expect(view.dom.querySelector('.cm-vim-prefix')?.getAttribute('aria-hidden')).toBe('true');
    press(command, 'Escape');
    expect(view.dom.querySelector('.cm-vim-panel')).toBeNull();
    keys(view, '/');
    const search = view.dom.querySelector<HTMLInputElement>('.cm-vim-panel input')!;
    expect(search.getAttribute('aria-label')).toBe('Buscar no Vim');
    // Descrição inglesa da biblioteca (alternância pcre) marcada como inglês, sem cor em linha.
    const desc = view.dom.querySelector<HTMLElement>('.cm-vim-desc')!;
    expect([desc.lang, desc.style.color]).toEqual(['en', '']);
    press(search, 'Escape');
  });

  test('/zzz sem resultado e :abc mostram a mensagem traduzida num role="status"', () => {
    const { view } = mount('abc', 0);
    keys(view, '/');
    answerPrompt(view, 'zzz');
    expect(message(view)).toBe('Nada encontrado: zzz');
    keys(view, ':');
    answerPrompt(view, 'abc');
    expect(message(view)).toBe('Comando não reconhecido: “:abc”');
    expect(view.dom.querySelector('.cm-vim-message')?.getAttribute('style')).toBeNull();
  });

  test('mensagem sem tradução fica no original dentro de <span lang="en">', () => {
    const { view } = mount('abc', 0);
    keys(view, ':');
    answerPrompt(view, 'version');
    const span = view.dom.querySelector('.cm-vim-panel [role="status"] span');
    expect([span?.getAttribute('lang'), span?.textContent]).toEqual([
      'en',
      'Codemirror-vim version: <DEV>',
    ]);
  });

  test.each([
    ['Invalid regex: [', 'Expressão regular inválida: ['],
    ['No word under cursor', 'Nenhuma palavra sob o cursor.'],
    ['No match found zzz (set nopcre to use Vim regexps)', 'Nada encontrado: zzz'],
    ['No matches for zzz (set nopcre to use vim regexps)', 'Nada encontrado: zzz'],
    ['No match found zzz', 'Nada encontrado: zzz'],
    ['3 lines yanked', '3 linhas copiadas.'],
    ['2 lines yanked into "a', '2 linhas copiadas para o registrador a.'],
    ['Not an editor command ":foo"', 'Comando não reconhecido: “:foo”'],
    ['Invalid mapping: jj', 'Mapeamento inválido: jj'],
    ['No such mapping: jj', 'Mapeamento inexistente: jj'],
    ['Argument is required.', 'Falta um argumento.'],
    ['Argument required', 'Falta um argumento.'],
    ['Regular Expression missing from global', 'Falta a expressão regular em :global.'],
    ['Substitutions should be of the form :s/pattern/replace/', 'Use a forma :s/padrão/troca/.'],
    ['No previous substitute regular expression', 'Nenhuma substituição anterior.'],
    ['Invalid argument: 3x', 'Argumento inválido: 3x'],
  ])('STR-161: %j → %j', (original, translated) => {
    expect(translateVimMessage(original)).toEqual({ lang: 'pt-BR', text: translated });
  });

  test('mensagem longa da biblioteca: cada linha traduzida ou marcada como inglês', () => {
    const template = document.createElement('div');
    const pre = template.appendChild(document.createElement('div'));
    pre.className = 'cm-vim-message';
    pre.textContent = 'No word under cursor';
    template.appendChild(document.createElement('div')).textContent =
      'Press ENTER or type command to continue';
    const out = localizeNotification(template);
    expect(out.getAttribute('role')).toBe('status');
    expect([...out.children].map((line) => line.innerHTML)).toEqual([
      'Nenhuma palavra sob o cursor.',
      '<span lang="en">Press ENTER or type command to continue</span>',
    ]);
  });

  test('prompt com prefixo em inglês (confirmação de :s///c): input nomeado, prefixo lang="en"', () => {
    const template = document.createElement('div');
    const field = template.appendChild(document.createElement('span'));
    field.append(document.createElement('span'), document.createElement('input'));
    field.firstElementChild!.textContent = 'replace with b (y/n/a/q/l)';
    localizePrompt(template);
    expect(template.querySelector('input')?.getAttribute('aria-label')).toBe(PROMPT_LABELS.command);
    expect(template.querySelector('.cm-vim-prefix')?.getAttribute('lang')).toBe('en');
    // Modelo sem input (defensivo): nada muda.
    const empty = document.createElement('div');
    localizePrompt(empty);
    expect(empty.innerHTML).toBe('');
  });
});
