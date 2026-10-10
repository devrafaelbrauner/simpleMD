// Portado de vslinko/obsidian-outliner@b51918d4eaa75223780a404c40f2d9406df6a3c0 (MIT), © 2021 Viacheslav Slinko. Modificado para o simpleMD.
// Origem: jest/md-spec-transformer.js (leitura dos `specs/*.spec.md`), jest/obsidian-expect.js
// (`stateToString`) e src/ObsidianOutlinerPluginWithTests.ts (`applyState`, `parseState`,
// `simulateKeydown`, `insertText`, `drag`/`move`/`drop`, `getCurrentState`). Mudanças: roda no
// Vitest + jsdom sobre um `EditorView` com o núcleo do simpleMD e o outliner (sem Obsidian nem
// WebSocket); o layout do arrasto é uma grade fixa (`GRID`); casos por plataforma pelo `platform`.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { foldedRanges, getIndentUnit } from '@codemirror/language';
import { EditorSelection } from '@codemirror/state';
import { EditorView, runScopeHandlers } from '@codemirror/view';
import {
  captureTabExtension,
  contextAction,
  createMarkdownExtensions,
  internalCommandsFacet,
} from '@simplemd/core';
import type { InternalCommand } from '@simplemd/plugin-api/internal/host';
import {
  createOutlinerContext,
  outlinerCommands,
  outlinerExtension,
  type OutlinerHost,
} from '../src/outliner/index';
import type { OutlinerContext } from '../src/outliner/context';
import { DragAndDropController, type DndLayout } from '../src/outliner/features/drag-and-drop';
import { MyEditor, type MyEditorPosition } from '../src/outliner/model/editor';
import type { KeepCursorWithinContent } from '../src/outliner/model/settings';

export type GoldenAction =
  | { type: 'applyState'; lines: string[] }
  | { type: 'assertState'; lines: string[] }
  | { type: 'keydown'; key: string }
  | { type: 'insertText'; text: string }
  | { type: 'execute'; command: string }
  | { type: 'setting'; k: string; v: unknown }
  | { type: 'platform'; platform: string }
  | { type: 'drag'; from: MyEditorPosition }
  | { type: 'move'; to: MyEditorPosition; offsetX: number; offsetY: number }
  | { type: 'drop' };

export interface GoldenCase {
  readonly file: string;
  readonly title: string;
  readonly actions: GoldenAction[];
}

export const SPECS_DIR = join(__dirname, 'fixtures/outliner');

/** Lê um `.spec.md` (formato do upstream: `# título`, ações `- x:` e blocos ```md). */
export function parseSpecFile(file: string, source: string): GoldenCase[] {
  const lines = source.split('\n').filter((line) => !line.startsWith('<!--'));
  let i = -1;
  const line = () => lines[i] ?? '';
  const ended = () => i >= lines.length;
  const nextNotEmpty = () => {
    do i++;
    while (!ended() && line().trim() === '');
  };
  const block = (): string[] => {
    nextNotEmpty();
    if (!line().startsWith('```')) throw new Error(`${file}: esperado \`\`\`, veio "${line()}"`);
    const out: string[] = [];
    for (i++; !ended() && !line().startsWith('```'); i++) out.push(line());
    if (ended()) throw new Error(`${file}: bloco sem fim`);
    nextNotEmpty();
    return out;
  };
  const arg = (prefix: string) => line().replace(new RegExp(`^- ${prefix}: \`([^\`]+)\`$`), '$1');
  const cases: GoldenCase[] = [];
  nextNotEmpty();
  while (!ended()) {
    if (!line().startsWith('# ')) throw new Error(`${file}: esperado título, veio "${line()}"`);
    const title = line().slice(2).trim();
    const actions: GoldenAction[] = [];
    nextNotEmpty();
    while (!ended() && !line().startsWith('# ')) {
      const current = line();
      if (current.startsWith('- applyState:')) actions.push({ type: 'applyState', lines: block() });
      else if (current.startsWith('- assertState:'))
        actions.push({ type: 'assertState', lines: block() });
      else {
        if (current.startsWith('- keydown:'))
          actions.push({ type: 'keydown', key: arg('keydown') });
        else if (current.startsWith('- insertText:'))
          actions.push({ type: 'insertText', text: arg('insertText') });
        else if (current.startsWith('- execute:'))
          actions.push({ type: 'execute', command: arg('execute') });
        else if (current.startsWith('- setting:')) {
          const [k = '', v = ''] = arg('setting').split('=', 2);
          actions.push({ type: 'setting', k, v: JSON.parse(v) });
        } else if (current.startsWith('- platform:'))
          actions.push({ type: 'platform', platform: arg('platform') });
        else if (current.startsWith('- drag:'))
          actions.push({ type: 'drag', from: JSON.parse(arg('drag')).from });
        else if (current.startsWith('- move:')) {
          const { to, offsetX = 0, offsetY = 0 } = JSON.parse(arg('move'));
          actions.push({ type: 'move', to, offsetX, offsetY });
        } else if (current.startsWith('- drop')) actions.push({ type: 'drop' });
        else throw new Error(`${file}: ação desconhecida "${current}"`);
        nextNotEmpty();
      }
    }
    cases.push({ file, title, actions });
  }
  return cases;
}

/** Todos os casos portados, na ordem dos arquivos. */
export function loadGoldenCases(): GoldenCase[] {
  return readdirSync(SPECS_DIR)
    .filter((name) => name.endsWith('.spec.md'))
    .sort()
    .flatMap((name) => parseSpecFile(name, readFileSync(join(SPECS_DIR, name), 'utf8')));
}

/**
 * Plataforma de um caso: a declarada (`darwin`/`linux`); sem declaração, `darwin` quando usa
 * teclas `Cmd-` (no upstream esses casos só passam no macOS) e as duas nos demais.
 */
export function casePlatforms(c: GoldenCase): ('mac' | 'other')[] {
  const declared = c.actions.find((a) => a.type === 'platform');
  if (declared?.type === 'platform') return [declared.platform === 'darwin' ? 'mac' : 'other'];
  const usesCmd = c.actions.some((a) => a.type === 'keydown' && /(^|-)Cmd-/.test(a.key));
  return usesCmd ? ['mac'] : ['mac', 'other'];
}

interface State {
  folds: number[];
  selections: { anchor: MyEditorPosition; head: MyEditorPosition }[];
  value: string;
}

/** `parseState` do upstream: `|` = âncora e cabeça; `#folded` = linha dobrada. */
export function parseState(content: string[]): State {
  let anchor: MyEditorPosition | null = null;
  let head: MyEditorPosition | null = null;
  const lines: string[] = [];
  const folds: number[] = [];
  content.forEach((raw, lineNo) => {
    let line = raw;
    if (line.includes('#folded')) {
      line = line.replace('#folded', '').trimEnd();
      folds.push(lineNo);
    }
    for (const which of ['anchor', 'head'] as const) {
      if ((which === 'anchor' ? anchor : head) !== null) continue;
      const index = line.indexOf('|');
      if (index < 0) continue;
      const pos = { line: lineNo, ch: index };
      if (which === 'anchor') anchor = pos;
      else head = pos;
      line = line.slice(0, index) + line.slice(index + 1);
    }
    lines.push(line);
  });
  const a: MyEditorPosition = anchor ?? { line: 0, ch: 0 };
  const h: MyEditorPosition = head ?? { ...a };
  return { folds, selections: [{ anchor: a, head: h }], value: lines.join('\n') };
}

/** `stateToString` do upstream (comparação do `toEqualEditorState`). */
export function stateToString(state: State): string {
  const lines = state.value.split('\n');
  const sels = new Set<string>();
  for (const sel of state.selections) {
    sels.add(`${sel.anchor.line}_${sel.anchor.ch}`);
    sels.add(`${sel.head.line}_${sel.head.ch}`);
  }
  let res = '';
  lines.forEach((line, l) => {
    for (let c = 0; c <= line.length; c++) {
      if (sels.has(`${l}_${c}`)) res += '|';
      if (c < line.length) res += line[c];
    }
    if (state.folds.includes(l)) res += ' #folded';
    res += '\n';
  });
  return res;
}

/** Grade de layout do arrasto (sem layout no jsdom): linha de 20 px, caractere de 9 px. */
export const GRID = { lineHeight: 20, charWidth: 9 };

const KEY_NAMES: Record<string, string> = { KeyA: 'a', KeyO: 'o' };

const COMMANDS: Record<string, string> = {
  'obsidian-outliner:move-list-item-up': 'move-up',
  'obsidian-outliner:move-list-item-down': 'move-down',
  'obsidian-outliner:indent-list': 'indent',
  'obsidian-outliner:outdent-list': 'outdent',
  'obsidian-outliner:fold': 'fold',
  'obsidian-outliner:unfold': 'unfold',
};

export interface GoldenEditor {
  readonly view: EditorView;
  readonly ctx: OutlinerContext;
  readonly announcements: string[];
  readonly commands: InternalCommand[];
  destroy(): void;
}

/**
 * Editor do simpleMD (núcleo + chave Tab ligada) com o outliner, na plataforma pedida. `outliner:
 * false` = o mesmo editor sem o plugin (comportamento "regular" do simpleMD, D-R7-S7-02).
 */
export function goldenEditor(platform: 'mac' | 'other', outliner = true): GoldenEditor {
  const announcements: string[] = [];
  const host: OutlinerHost = {
    pluginId: 'simplemd.outliner',
    platform,
    editor: {
      contextAction: (slot, action) => contextAction(slot, action),
      interact: () => [],
      escape: () => [],
      announce: (text) => announcements.push(text),
    },
    palette: (commands) => internalCommandsFacet.of(commands),
  };
  const ctx = createOutlinerContext(host);
  const view = new EditorView({
    extensions: [
      createMarkdownExtensions(),
      captureTabExtension,
      outliner ? outlinerExtension(host, ctx) : [],
    ],
    parent: document.body,
  });
  return {
    view,
    ctx,
    announcements,
    commands: outlinerCommands(ctx, host.pluginId),
    destroy: () => view.destroy(),
  };
}

function wait(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

function currentState(view: EditorView): State {
  const editor = new MyEditor(view);
  return {
    folds: editor.getAllFoldedLines(),
    selections: editor.listSelections(),
    value: editor.getValue(),
  };
}

/**
 * Movimentos padrão do editor que dependem de layout (o jsdom não mede): ↑/↓ vão para a linha
 * visível anterior/seguinte (pulando as dobradas) na mesma coluna; ⌘→ (macOS) vai ao fim da linha.
 * `true` quando a tecla é um desses movimentos (o outliner não liga nenhuma delas).
 */
function layoutMotion(view: EditorView, platform: 'mac' | 'other', keyName: string): boolean {
  const { state } = view;
  const head = state.selection.main.head;
  const line = state.doc.lineAt(head);
  if (platform === 'mac' && keyName === 'Cmd-ArrowRight') {
    view.dispatch({ selection: { anchor: line.to }, userEvent: 'select' });
    return true;
  }
  if (keyName !== 'ArrowUp' && keyName !== 'ArrowDown') return false;
  const hidden = (n: number) => {
    let inside = false;
    foldedRanges(state).between(0, state.doc.length, (from, to) => {
      const start = state.doc.line(n).from;
      if (start > from && start <= to) inside = true;
    });
    return inside;
  };
  const step = keyName === 'ArrowUp' ? -1 : 1;
  let n = line.number + step;
  while (n >= 1 && n <= state.doc.lines && hidden(n)) n += step;
  // Sem linha acima/abaixo: início/fim do documento (como o CM).
  let pos = n < 1 ? 0 : state.doc.length;
  if (n >= 1 && n <= state.doc.lines) {
    const target = state.doc.line(n);
    pos = target.from + Math.min(head - line.from, target.length);
  }
  view.dispatch({ selection: { anchor: pos }, userEvent: 'select' });
  return true;
}

/** Layout em grade para o `DragAndDropController` (mesmas contas do upstream). */
function gridLayout(view: EditorView): DndLayout {
  return {
    leftPadding: 0,
    // Como `measureLayout` sem linha indentada: largura de caractere × `indentUnit`.
    tabWidth: GRID.charWidth * getIndentUnit(view.state),
    lineBox: (line) => ({ top: line * GRID.lineHeight, height: GRID.lineHeight }),
  };
}

/** Executa um caso; devolve as comparações `[recebido, esperado]` de cada `assertState`. */
export async function runGolden(
  c: GoldenCase,
  platform: 'mac' | 'other',
  outliner = true,
): Promise<[string, string][]> {
  const g = goldenEditor(platform, outliner);
  const { view, ctx } = g;
  const editor = () => new MyEditor(view);
  const dnd = new DragAndDropController(ctx, view, gridLayout);
  const results: [string, string][] = [];
  try {
    for (const action of c.actions) {
      switch (action.type) {
        case 'applyState': {
          const state = parseState(action.lines);
          editor().setValue('');
          editor().setValue(state.value);
          editor().setSelections(state.selections);
          for (const line of state.folds) editor().fold(line);
          await wait(10);
          break;
        }
        case 'assertState':
          await wait(10);
          results.push([
            stateToString(currentState(view)),
            stateToString(parseState(action.lines)),
          ]);
          break;
        case 'keydown': {
          const init: KeyboardEventInit = {};
          let code = '';
          for (const part of action.key.split('-')) {
            const lower = part.toLowerCase();
            if (lower === 'cmd') init.metaKey = true;
            else if (lower === 'ctrl') init.ctrlKey = true;
            else if (lower === 'alt') init.altKey = true;
            else if (lower === 'shift') init.shiftKey = true;
            else code = part;
          }
          const key = KEY_NAMES[code] ?? code;
          if (!layoutMotion(view, platform, action.key))
            runScopeHandlers(view, new KeyboardEvent('keydown', { ...init, key, code }), 'editor');
          break;
        }
        case 'insertText': {
          const { from, to } = view.state.selection.main;
          const handled = view.state.facet(EditorView.inputHandler).some((handler) =>
            handler(view, from, to, action.text, () =>
              view.state.update({
                changes: { from, to, insert: action.text },
                selection: EditorSelection.cursor(from + action.text.length),
                userEvent: 'input.type',
              }),
            ),
          );
          if (!handled)
            view.dispatch({
              changes: { from, to, insert: action.text },
              selection: EditorSelection.cursor(from + action.text.length),
              userEvent: 'input.type',
            });
          break;
        }
        case 'execute': {
          const id = COMMANDS[action.command];
          const command = g.commands.find((cmd) => cmd.id === `simplemd.outliner:${id}`);
          if (!command) throw new Error(`comando sem porte: ${action.command}`);
          command.run(view);
          break;
        }
        case 'setting':
          if (action.k === 'stickCursor') {
            const v = action.v;
            ctx.settings.keepCursorWithinContent = (
              v === true ? 'bullet-and-checkbox' : v === false ? 'never' : v
            ) as KeepCursorWithinContent;
          } else if (action.k !== 'dnd') throw new Error(`ajuste sem porte: ${action.k}`);
          break;
        case 'platform':
          break;
        case 'drag':
          dnd.start(editor().posToOffset(action.from));
          break;
        case 'move': {
          const pos = editor().offsetToPos(editor().posToOffset(action.to));
          dnd.move(
            pos.ch * GRID.charWidth + action.offsetX,
            pos.line * GRID.lineHeight + action.offsetY,
          );
          break;
        }
        case 'drop':
          dnd.drop();
          break;
      }
    }
  } finally {
    g.destroy();
  }
  return results;
}

/**
 * Casos em que o upstream afirma que o outliner NÃO age e roda o comportamento padrão do editor
 * (D-R7-S7-02): o esperado é o mesmo editor do simpleMD sem o outliner, com o motivo da diferença
 * para o Obsidian.
 */
export const REGULAR_BEHAVIOUR: Record<string, string> = {
  "BackspaceBehaviourOverride.spec.md › backspace should work as regular if it's last empty line":
    'o Backspace do lang-markdown apaga o marcador inteiro (Obsidian: 1 caractere)',
  "BackspaceBehaviourOverride.spec.md › backspace should work as regular if it's first line without children":
    'o Backspace do lang-markdown apaga o marcador inteiro (Obsidian: 1 caractere)',
  'EnterBehaviourOverride.spec.md › enter should fallback behavior while multiline selection':
    'o Enter do lang-markdown continua a lista com a indentação dele (Obsidian: 2 espaços)',
  'EditorSelectionsBehaviourOverride.spec.md › cursor should not be moved when printing wikilink':
    'o simpleMD não fecha colchetes sozinho (Obsidian: `[[` vira `[[]]`)',
};

/** `[recebido, esperado]` de cada `assertState`, com o esperado "regular" quando o caso pede. */
export async function checkGolden(
  c: GoldenCase,
  platform: 'mac' | 'other',
): Promise<[string, string][]> {
  const got = await runGolden(c, platform);
  if (!(`${c.file} › ${c.title}` in REGULAR_BEHAVIOUR)) return got;
  const plain = await runGolden(c, platform, false);
  return got.map(([received], i) => [received, plain[i]?.[0] ?? '']);
}
