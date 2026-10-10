import type { Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { escapeHandler, interactFacet, problemsCommandsFacet } from '@simplemd/core';
import type { PluginAPI } from '@simplemd/plugin-api';
import type { ConfigFileRead, InternalHostContext } from '@simplemd/plugin-api/internal/host';

/** Leituras e aberturas observadas pelo host falso do lint. */
export interface FakeLintHost {
  readonly host: InternalHostContext;
  /** Nomes pedidos a `host.files.read`, em ordem. */
  readonly reads: string[];
  readonly opened: string[];
  /** Troca o conteúdo de um arquivo da pasta e dispara `files.onChange`. */
  change(name: string, content: string | undefined): void;
}

/**
 * Host interno falso com as ligações REAIS do núcleo (`interactFacet`, `escapeHandler`,
 * `problemsCommandsFacet`), arquivos em memória e só a lista fechada do lint legível.
 */
export function fakeLintHost(files: Record<string, string | ConfigFileRead> = {}): FakeLintHost {
  const reads: string[] = [];
  const opened: string[] = [];
  const listeners = new Set<(name: string) => void>();
  const content = new Map(Object.entries(files));
  const allowed = ['.markdownlint.json', '.markdownlint.jsonc'];
  const host: InternalHostContext = {
    pluginId: 'simplemd.lint',
    platform: 'other',
    editor: {
      contextAction: () => [],
      interact: (run) => interactFacet.of({ order: 10, run }),
      escape: (owner, run) => escapeHandler(owner, run),
      problems: (commands) => problemsCommandsFacet.of(commands),
      announce: () => {},
    },
    options: { get: <T>() => undefined as T, subscribe: () => () => {} },
    links: { openExternal: (url) => opened.push(url) },
    files: {
      read: async (name) => {
        reads.push(name);
        if (!allowed.includes(name)) return { error: 'missing' };
        const file = content.get(name);
        if (file === undefined) return { error: 'missing' };
        return typeof file === 'string' ? { text: file } : file;
      },
      onChange: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  };
  return {
    host,
    reads,
    opened,
    change(name, text) {
      if (text === undefined) content.delete(name);
      else content.set(name, text);
      for (const listener of listeners) listener(name);
    },
  };
}

/** API v1 falsa: guarda a extensão registrada e os avisos. */
export function fakeApi(): { api: PluginAPI; extensions: Extension[]; notices: string[] } {
  const extensions: Extension[] = [];
  const notices: string[] = [];
  const api = {
    registerCommand: () => {},
    registerEditorExtension: (ext: { source?: Extension }) => {
      if (ext.source) extensions.push(ext.source);
    },
    registerPanel: () => {},
    registerCompletionSource: () => {},
    on: () => () => {},
    vault: { read: async () => '', write: async () => {}, list: async () => [] },
    settings: { get: () => undefined, set: async () => {} },
    ui: { notify: (msg: string) => notices.push(msg) },
  } as unknown as PluginAPI;
  return { api, extensions, notices };
}

/** Texto do anúncio mais recente do CM (`EditorView.announce`, região `.cm-announced`). */
export function lastAnnouncement(view: EditorView): string {
  return view.dom.querySelector('.cm-announced')?.textContent ?? '';
}
