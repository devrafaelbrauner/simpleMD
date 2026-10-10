// @vitest-environment jsdom
import '../../../packages/core/test/setup-dom';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EditorState, type Extension } from '@codemirror/state';
import { keymap, type KeyBinding } from '@codemirror/view';
import {
  captureTabExtension,
  contextChainKeymap,
  EDITOR_KEY_BINDINGS,
  EditorHost,
  EMPTY_CONTRIBUTIONS,
  markdownKeymap,
  markdownLanguageSupport,
  TAB_FOCUS_HOTKEY,
} from '@simplemd/core';
import type { PluginAPI } from '@simplemd/plugin-api';
import type { InternalHostContext } from '@simplemd/plugin-api/internal/host';
import { builtinHotkeys, normalizeHotkey, type Platform } from '@simplemd/plugin-api/runtime';
import { describe, expect, test } from 'vitest';
import { GLOBAL_KEYS } from '../src/app/global-keys';
import { internalPluginDescriptors, type InternalAppServices } from '../src/plugins/internal/index';

/**
 * AC-X7.5 (R-X7.5, arch-ux §6.2–§6.5, CF-R7-9): teste de conflitos de atalhos que DESCOBRE sozinho
 * as teclas — keymaps do núcleo (estado montado pelo `EditorHost` com a chave Tab ligada), atalhos
 * globais (`GLOBAL_KEYS`), menu nativo do macOS (lido de `src-tauri/src/lib.rs`) e, para cada plugin
 * interno registrado em `plugins/internal/`, os keymaps das extensões e os atalhos dos comandos que
 * ele registra ao ativar. Por plataforma: 0 duplicatas de Classe A; teclas de Classe B só pela
 * cadeia de contexto ou pelas ligações existentes declaradas.
 */
const PLATFORMS: readonly Platform[] = ['mac', 'other'];

/** Tecla efetiva de uma ligação do CM na plataforma (+ variante Shift). */
function keysOf(binding: KeyBinding, platform: Platform): string[] {
  const key = (platform === 'mac' ? binding.mac : (binding.win ?? binding.linux)) ?? binding.key;
  if (!key) return [];
  const out = [normalizeHotkey(key, platform)];
  if (binding.shift) out.push(normalizeHotkey(`Shift-${key}`, platform));
  return out;
}

function bindingsOf(extension: Extension): KeyBinding[] {
  return EditorState.create({ extensions: extension })
    .facet(keymap)
    .flat()
    .filter((b) => (b.scope ?? 'editor').split(' ').includes('editor'));
}

/** Plugins internos ativados com uma API que só grava: extensões e atalhos de comando. */
async function internalContributions() {
  const found: { id: string; extensions: Extension[]; hotkeys: string[] }[] = [];
  for (const descriptor of internalPluginDescriptors()) {
    const extensions: Extension[] = [];
    const hotkeys: string[] = [];
    const host = {
      pluginId: descriptor.id,
      platform: 'other',
      editor: {},
      options: { get: () => undefined, subscribe: () => () => {} },
      links: { openExternal: () => {} },
    } as unknown as InternalHostContext;
    const module = await descriptor.load({
      pluginId: descriptor.id,
      host,
      services: {} as InternalAppServices,
    });
    const api = {
      registerCommand: (_id: string, cmd: { hotkey?: string }) => {
        if (cmd.hotkey) hotkeys.push(cmd.hotkey);
      },
      registerEditorExtension: (ext: { source?: Extension }) => {
        if (ext.source) extensions.push(ext.source);
      },
      registerPanel: () => {},
      registerCompletionSource: () => {},
      on: () => () => {},
      vault: { read: async () => '', write: async () => {}, list: async () => [] },
      settings: { get: () => undefined, set: async () => {} },
      ui: { notify: () => {} },
    } as unknown as PluginAPI;
    module.default(api);
    found.push({ id: descriptor.id, extensions, hotkeys });
  }
  return found;
}

/** Itens do menu do macOS (predefinidos do Tauri → acelerador do sistema) + `.accelerator(...)`. */
function macMenuKeys(): string[] {
  const lib = readFileSync(join(__dirname, '../src-tauri/src/lib.rs'), 'utf8');
  const menu = lib.slice(lib.indexOf('fn build_menu'), lib.indexOf('fn close_main'));
  const PREDEFINED: Record<string, string> = {
    hide: 'Mod-h',
    hide_others: 'Mod-Alt-h',
    undo: 'Mod-z',
    redo: 'Mod-Shift-z',
    cut: 'Mod-x',
    copy: 'Mod-c',
    paste: 'Mod-v',
    select_all: 'Mod-a',
    minimize: 'Mod-m',
  };
  const keys = [...menu.matchAll(/\.(\w+)\(\)/g)]
    .map((m) => PREDEFINED[m[1] ?? ''])
    .filter((k): k is string => k !== undefined);
  for (const m of menu.matchAll(/\.accelerator\("CmdOrCtrl\+(\w)"\)/g))
    keys.push(`Mod-${(m[1] ?? '').toLowerCase()}`);
  return keys;
}

/** Itens do menu que são as mesmas ações de edição do editor (o menu entrega ao webview). */
const MENU_EDIT_ACTIONS = ['Mod-z', 'Mod-Shift-z', 'Mod-x', 'Mod-c', 'Mod-v', 'Mod-a'];

/**
 * Classe B (arch-ux §6.4) e duplicatas já existentes do r1/r2 entre CM/MD/AC/`lang-markdown`
 * (popup sobre o CM; `Mod-i` do MD sobre o `selectParentSyntax`): única lista de exceções.
 */
const CLASS_B = [
  'Tab',
  'Shift-Tab',
  'Mod-]',
  'Mod-[',
  'Mod-Alt-ArrowRight',
  'Mod-Alt-ArrowLeft',
  'Enter',
  'Shift-Enter',
  'Backspace',
  'Delete',
  'Mod-a',
  'Home',
  'End',
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
  'PageUp',
  'PageDown',
  'Escape',
  'Mod-i',
];
/** Só a cadeia de contexto (ou o árbitro do Escape) pode ligar estas teclas (arch-ux §6.4). */
const CHAIN_ONLY = [
  'Tab',
  'Shift-Tab',
  'Mod-]',
  'Mod-[',
  'Mod-Alt-ArrowRight',
  'Mod-Alt-ArrowLeft',
];

describe.each(PLATFORMS)('AC-X7.5 conflitos de atalhos — %s', (platform) => {
  const norm = (key: string) => normalizeHotkey(key, platform);
  const allowedB = new Set(CLASS_B.map(norm));

  test('Classe A única: globais, menu, comandos de plugin e o alternador do modo de foco', async () => {
    const plugins = await internalContributions();
    const owners = new Map<string, string[]>();
    const add = (key: string, owner: string) =>
      owners.set(norm(key), [...(owners.get(norm(key)) ?? []), owner]);
    for (const g of GLOBAL_KEYS) add(g.key, `global:${g.id}`);
    for (const p of plugins) for (const key of p.hotkeys) add(key, `plugin:${p.id}`);
    if (platform === 'mac')
      for (const key of macMenuKeys())
        if (!MENU_EDIT_ACTIONS.includes(key)) add(key, `menu:${key}`);
    add(TAB_FOCUS_HOTKEY[platform], 'editor:toggle-tab-focus');
    const duplicates = [...owners].filter(([, list]) => list.length > 1);
    expect(duplicates).toEqual([]);
    // Nenhuma tecla de Classe A é também tecla do editor (o global venceria em silêncio, D-38),
    // exceto a substituição declarada na MESMA tecla: o alternador sobre o `toggleTabFocusMode`.
    const editorKeys = new Set(EDITOR_KEY_BINDINGS.flatMap((b) => keysOf(b, platform)));
    const clash = [...owners.keys()].filter(
      (key) => editorKeys.has(key) && key !== norm(TAB_FOCUS_HOTKEY[platform]),
    );
    expect(clash).toEqual([]);
    // Os atalhos de plugin nunca usam uma tecla reservada do app (BUILTIN_KEYS + editor).
    const reserved = builtinHotkeys(EDITOR_KEY_BINDINGS, platform);
    for (const p of plugins)
      for (const key of p.hotkeys) expect(reserved.has(norm(key))).toBe(false);
  });

  test('Classe B: duplicatas no editor montado só nas teclas declaradas; Tab só pela cadeia', async () => {
    const plugins = await internalContributions();
    const host = new EditorHost({
      ...EMPTY_CONTRIBUTIONS,
      captureTab: true,
      pluginExtensions: plugins.flatMap((p) => p.extensions),
      completion: { enabled: true, activateOnTyping: true, sources: [() => null] },
    });
    // O `defaultKeymap` do CM tem ligações repetidas entre si (upstream, desde o r1): ele conta
    // como UMA fonte por tecla; o conflito é entre fontes (CM, MD, popup, cadeia, plugins).
    const cm = new Set<KeyBinding>(EDITOR_KEY_BINDINGS);
    const all = host.createState('').facet(keymap).flat();
    const count = new Map<string, number>();
    const cmKeys = new Set<string>();
    for (const binding of all) {
      if (!(binding.scope ?? 'editor').split(' ').includes('editor')) continue;
      for (const key of keysOf(binding, platform)) {
        if (cm.has(binding)) {
          if (cmKeys.has(key)) continue;
          cmKeys.add(key);
        }
        count.set(key, (count.get(key) ?? 0) + 1);
      }
    }
    const duplicates = [...count].filter(([key, n]) => n > 1 && !allowedB.has(key));
    expect(duplicates).toEqual([]);
    // Fontes conhecidas descobertas por extensão: a cadeia liga as teclas de Classe B da tabela.
    const chain = [...bindingsOf(contextChainKeymap), ...bindingsOf(captureTabExtension)].flatMap(
      (b) => keysOf(b, platform),
    );
    expect(chain.sort()).toEqual(CHAIN_ONLY.map(norm).sort());
    // Nenhum plugin interno liga Tab/Mod-]/Mod-[/Mod-Alt-→← fora da cadeia.
    const chainOnly = new Set(CHAIN_ONLY.map(norm));
    for (const p of plugins)
      for (const ext of p.extensions)
        for (const b of bindingsOf(ext))
          for (const key of keysOf(b, platform))
            expect(chainOnly.has(key), `${p.id} ${key}`).toBe(false);
    // As fontes do r1/r2 continuam presentes (a descoberta não perdeu nada).
    expect(count.get(norm('Mod-b'))).toBeGreaterThan(0);
    expect(bindingsOf(markdownKeymap).length).toBeGreaterThan(0);
    expect(bindingsOf(markdownLanguageSupport()).length).toBeGreaterThan(0);
  });
});
