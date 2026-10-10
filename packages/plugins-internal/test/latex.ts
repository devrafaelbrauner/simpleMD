import { ensureSyntaxTree } from '@codemirror/language';
import type { Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import {
  appPlatformFacet,
  contextAction,
  EditorHost,
  EMPTY_CONTRIBUTIONS,
  escapeHandler,
  internalCommandsFacet,
} from '@simplemd/core';
import type { InternalHostContext } from '@simplemd/plugin-api/internal/host';
import { defaultSnippets, SnippetCatalog } from '../src/latex-snippets/catalog';
import type { LatexSuiteSettings } from '../src/latex-snippets/cm/config';
import { latexSnippetsExtension } from '../src/latex-snippets/index';

/** Opções do plugin nos testes (padrão: todas ligadas, como no descritor). */
export interface LatexOptions {
  autofraction?: boolean;
  matrixShortcuts?: boolean;
  tabout?: boolean;
  autoEnlargeBrackets?: boolean;
}

export interface Mounted {
  readonly view: EditorView;
  readonly announced: string[];
  readonly settings: LatexSuiteSettings;
}

/** Contexto privado do host com as fábricas REAIS do núcleo (o mesmo de `internal-context.ts`). */
export function fakeHost(
  announced: string[],
  platform: 'mac' | 'other' = 'mac',
): InternalHostContext {
  return {
    pluginId: 'simplemd.latex-snippets',
    platform,
    editor: {
      contextAction: (slot, action) => contextAction(slot, action),
      interact: () => [],
      escape: (owner, run) => escapeHandler(owner, run),
      announce: (text) => announced.push(text),
    },
    palette: (commands) => internalCommandsFacet.of(commands),
    options: { get: <T>() => undefined as T, subscribe: () => () => {} },
    links: { openExternal: () => {} },
  };
}

const views: EditorView[] = [];

export function destroyLatexViews(): void {
  while (views.length) views.pop()?.destroy();
  document.body.innerHTML = '';
}

/**
 * Editor com a pilha REAL do app (`EditorHost`: markdown, histórico, cadeia de contexto, árbitro do
 * Esc) e o plugin no compartimento de plugins. `doc` usa `|` para o cursor ou `[`…`]` para a seleção.
 */
export function mountLatex(
  doc: string,
  opts: LatexOptions & { captureTab?: boolean; catalog?: SnippetCatalog; extra?: Extension[] } = {},
): Mounted {
  const announced: string[] = [];
  const settings: LatexSuiteSettings = {
    catalog: () => opts.catalog ?? new SnippetCatalog(defaultSnippets()),
    autofraction: () => opts.autofraction ?? true,
    matrixShortcuts: () => opts.matrixShortcuts ?? true,
    tabout: () => opts.tabout ?? true,
    autoEnlargeBrackets: () => opts.autoEnlargeBrackets ?? true,
    announce: (text) => announced.push(text),
    platform: 'mac',
    hint: { shown: false },
  };
  const host = new EditorHost(
    {
      ...EMPTY_CONTRIBUTIONS,
      captureTab: opts.captureTab ?? false,
      pluginExtensions: [
        latexSnippetsExtension(settings, fakeHost(announced)),
        ...(opts.extra ?? []),
      ],
    },
    appPlatformFacet.of('mac'),
  );
  const { text, anchor, head } = parseCursor(doc);
  const parent = document.body.appendChild(document.createElement('div'));
  const view = new EditorView({ state: host.createState(text), parent });
  view.dispatch({ selection: { anchor, head } });
  ensureSyntaxTree(view.state, view.state.doc.length, 5000);
  views.push(view);
  return { view, announced, settings };
}

export function parseCursor(doc: string): { text: string; anchor: number; head: number } {
  const bar = doc.indexOf('|');
  if (bar !== -1) return { text: doc.replace('|', ''), anchor: bar, head: bar };
  const open = doc.indexOf('[');
  const close = doc.indexOf(']');
  if (open === -1 || close === -1) return { text: doc, anchor: doc.length, head: doc.length };
  return {
    text: doc.slice(0, open) + doc.slice(open + 1, close) + doc.slice(close + 1),
    anchor: open,
    head: close - 1,
  };
}

/** Documento com `|` no cursor principal (ou `[`…`]` em volta da seleção principal). */
export function show(view: EditorView): string {
  const doc = view.state.doc.toString();
  const { from, to } = view.state.selection.main;
  if (from === to) return `${doc.slice(0, from)}|${doc.slice(from)}`;
  return `${doc.slice(0, from)}[${doc.slice(from, to)}]${doc.slice(to)}`;
}

export function keydown(
  view: EditorView,
  init: KeyboardEventInit & { keyCode?: number },
): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  if (init.keyCode !== undefined) Object.defineProperty(event, 'keyCode', { value: init.keyCode });
  view.contentDOM.dispatchEvent(event);
  return event;
}

/**
 * Digita como o navegador: `keydown` em cada caractere; se ninguém consumiu, o caractere entra
 * como digitação comum (`input.type`).
 */
export function type(view: EditorView, text: string): void {
  for (const ch of text) {
    const key = ch === '\n' ? 'Enter' : ch;
    if (keydown(view, { key }).defaultPrevented) continue;
    view.dispatch(view.state.update(view.state.replaceSelection(ch), { userEvent: 'input.type' }));
    ensureSyntaxTree(view.state, view.state.doc.length, 5000);
  }
}
