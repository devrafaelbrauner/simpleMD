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
  internalCommandsFacet,
  markdownKeymap,
  markdownLanguageSupport,
  TAB_FOCUS_HOTKEY,
} from '@simplemd/core';
import type { PluginAPI } from '@simplemd/plugin-api';
import { builtinHotkeys, normalizeHotkey, type Platform } from '@simplemd/plugin-api/runtime';
import { describe, expect, test } from 'vitest';
import { GLOBAL_KEYS } from '../src/app/global-keys';
import { createInternalHostContext } from '../src/plugins/internal-context';
import { internalPluginDescriptors, type InternalAppServices } from '../src/plugins/internal/index';
import { setup, type Harness } from './helpers';

/**
 * AC-X7.5 (R-X7.5, arch-ux §6.2–§6.5, CF-R7-9): teste de conflitos de atalhos que DESCOBRE sozinho
 * as teclas — keymaps do editor MONTADO (o `EditorHost` real do app, com os serviços, a chave Tab
 * ligada, o autocompletar e as extensões dos plugins internos), atalhos globais (`GLOBAL_KEYS`),
 * menu nativo do macOS (lido de `src-tauri/src/lib.rs`) e, para cada plugin interno registrado em
 * `plugins/internal/`, os keymaps das extensões e os atalhos dos comandos que ele registra ao ativar
 * (com o MESMO contexto de host da produção, por plataforma). Por plataforma: 0 duplicatas de
 * Classe A, nenhuma tecla de Classe A ligada no editor, e teclas de Classe B só pela cadeia de
 * contexto ou pelas ligações existentes declaradas.
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

/** Ligações de escopo `editor` de um estado (ou de um estado criado só com a extensão). */
function bindingsOf(source: Extension | EditorState): KeyBinding[] {
  const state = source instanceof EditorState ? source : EditorState.create({ extensions: source });
  return state
    .facet(keymap)
    .flat()
    .filter((b) => (b.scope ?? 'editor').split(' ').includes('editor'));
}

interface Contribution {
  readonly id: string;
  readonly extensions: Extension[];
  readonly hotkeys: string[];
  /** Atalhos mostrados dos comandos `host.palette` (a tecla é ligada pelo keymap do plugin). */
  readonly paletteKeys: string[];
}

/**
 * Plugins internos ativados com o contexto de host da produção (`createInternalHostContext`, na
 * plataforma da rodada) e uma API que só grava: extensões e atalhos de comando.
 */
async function internalContributions(h: Harness, platform: Platform): Promise<Contribution[]> {
  const found: Contribution[] = [];
  for (const descriptor of internalPluginDescriptors()) {
    const extensions: Extension[] = [];
    const hotkeys: string[] = [];
    const defaults = new Map((descriptor.options ?? []).map((spec) => [spec.key, spec.default]));
    const host = createInternalHostContext(descriptor.id, {
      platform,
      statusBar: h.app.plugins.statusBar,
      view: () => null,
      options: () => ({
        get: <T>(key: string) => defaults.get(key) as T,
        subscribe: () => () => {},
      }),
      openExternal: () => {},
      readConfigFile: async () => null,
      watchConfigFiles: () => () => {},
      languageTool: h.platform.languageTool,
    });
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
    const paletteKeys = EditorState.create({ extensions })
      .facet(internalCommandsFacet)
      .flatMap((command) => (command.hotkey ? [command.hotkey] : []));
    found.push({ id: descriptor.id, extensions, hotkeys, paletteKeys });
  }
  return found;
}

/**
 * Ligações (escopo `editor`) do estado montado pelo `EditorHost` REAL do app (serviços do editor
 * incluídos), com a chave Tab ligada, o autocompletar ativo e as `extra` extensões no compartimento
 * de plugins. Toda fonte de keymap do editor aparece aqui sem ser listada à mão.
 */
function mountedBindings(h: Harness, extra: readonly Extension[]): KeyBinding[] {
  const { host } = h.app.plugins.editor;
  host.update({
    captureTab: true,
    pluginExtensions: extra,
    completion: { enabled: true, activateOnTyping: true, sources: [() => null] },
  });
  return bindingsOf(host.createState(''));
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
/** Só a cadeia de contexto pode ligar estas teclas (arch-ux §6.4, DA-R7-15). */
const CHAIN_ONLY = [
  'Tab',
  'Shift-Tab',
  'Mod-]',
  'Mod-[',
  'Mod-Alt-ArrowRight',
  'Mod-Alt-ArrowLeft',
];
/** Substituições declaradas (DA-R7-15): o `indentMore`/`indentLess` do CM ficam sob a cadeia. */
const CHAIN_SUBSTITUTED = ['Mod-]', 'Mod-['];

/** Donos de cada tecla de Classe A na plataforma (globais, menu, comandos de plugin, alternador). */
function classAOwners(platform: Platform, plugins: readonly Contribution[]) {
  const norm = (key: string) => normalizeHotkey(key, platform);
  const owners = new Map<string, string[]>();
  const add = (key: string, owner: string) =>
    owners.set(norm(key), [...(owners.get(norm(key)) ?? []), owner]);
  for (const g of GLOBAL_KEYS) add(g.key, `global:${g.id}`);
  for (const p of plugins) for (const key of p.hotkeys) add(key, `plugin:${p.id}`);
  for (const p of plugins) for (const key of p.paletteKeys) add(key, `palette:${p.id}`);
  if (platform === 'mac')
    for (const key of macMenuKeys()) if (!MENU_EDIT_ACTIONS.includes(key)) add(key, `menu:${key}`);
  add(TAB_FOCUS_HOTKEY[platform], 'editor:toggle-tab-focus');
  return owners;
}

/**
 * Teclas de Classe A também ligadas no editor montado (o global venceria em silêncio, D-38), exceto
 * a substituição declarada na MESMA tecla (o alternador sobre o `toggleTabFocusMode`) e a tecla de
 * um comando `host.palette`, que o próprio plugin liga no editor (JEV D-R7-M05; outra fonte na
 * mesma tecla reprova no teste de Classe B).
 */
function classAClash(
  platform: Platform,
  owners: ReadonlyMap<string, string[]>,
  editor: readonly KeyBinding[],
): string[] {
  const editorKeys = new Set(editor.flatMap((b) => keysOf(b, platform)));
  const toggle = normalizeHotkey(TAB_FOCUS_HOTKEY[platform], platform);
  return [...owners]
    .filter(
      ([key, list]) =>
        editorKeys.has(key) && key !== toggle && !list.every((o) => o.startsWith('palette:')),
    )
    .map(([key]) => key)
    .sort();
}

/**
 * Ligações de teclas "só pela cadeia" que NÃO vêm da cadeia (qualquer fonte: núcleo, markdown,
 * autocompletar, serviços ou plugins), nem das substituições declaradas do `defaultKeymap`.
 */
function chainOnlyViolations(platform: Platform, editor: readonly KeyBinding[]): string[] {
  const norm = (key: string) => normalizeHotkey(key, platform);
  const chainOnly = new Set(CHAIN_ONLY.map(norm));
  const substituted = new Set(CHAIN_SUBSTITUTED.map(norm));
  const chain = new Set([...bindingsOf(contextChainKeymap), ...bindingsOf(captureTabExtension)]);
  const cm = new Set(EDITOR_KEY_BINDINGS);
  const out: string[] = [];
  for (const binding of editor) {
    if (chain.has(binding)) continue;
    for (const key of keysOf(binding, platform)) {
      if (!chainOnly.has(key)) continue;
      if (cm.has(binding) && substituted.has(key)) continue;
      out.push(key);
    }
  }
  return out.sort();
}

describe.each(PLATFORMS)('AC-X7.5 conflitos de atalhos — %s', (platform) => {
  const norm = (key: string) => normalizeHotkey(key, platform);
  const allowedB = new Set(CLASS_B.map(norm));

  test('Classe A única e fora do editor montado: globais, menu, comandos de plugin, alternador', async () => {
    const h = await setup({});
    const plugins = await internalContributions(h, platform);
    const owners = classAOwners(platform, plugins);
    const duplicates = [...owners].filter(([, list]) => list.length > 1);
    expect(duplicates).toEqual([]);
    const editor = mountedBindings(
      h,
      plugins.flatMap((p) => p.extensions),
    );
    // A descoberta vê as fontes do editor além do `defaultKeymap` (markdown, popup, cadeia).
    const keys = new Set(editor.flatMap((b) => keysOf(b, platform)));
    for (const key of ['Mod-b', 'Ctrl-Space', 'Tab', 'Mod-Alt-ArrowRight'])
      expect(keys).toContain(norm(key));
    expect(classAClash(platform, owners, editor)).toEqual([]);
    // O atalho mostrado de um comando `host.palette` está de fato ligado no editor montado (CR-PAL-02).
    for (const p of plugins) for (const key of p.paletteKeys) expect(keys).toContain(norm(key));
    // Os atalhos de plugin nunca usam uma tecla reservada do app (BUILTIN_KEYS + editor).
    const reserved = builtinHotkeys(EDITOR_KEY_BINDINGS, platform);
    for (const p of plugins)
      for (const key of p.hotkeys) expect(reserved.has(norm(key))).toBe(false);
  });

  test('negativo (mutação C da G-CR): tecla global ligada num keymap do editor é conflito', async () => {
    const h = await setup({});
    const owners = classAOwners(platform, []);
    const editor = mountedBindings(h, [
      keymap.of([
        { key: 'Mod-o', run: () => true },
        { key: 'Mod-Shift-p', run: () => true },
      ]),
    ]);
    expect(classAClash(platform, owners, editor)).toEqual(
      [norm('Mod-o'), norm('Mod-Shift-p')].sort(),
    );
  });

  test('palette (D-R7-M05): a tecla mostrada pode ser ligada pelo plugin, mas não repetir um global', async () => {
    const h = await setup({});
    const palette = (key: string): Contribution => ({
      id: 'simplemd.teste',
      extensions: [],
      hotkeys: [],
      paletteKeys: [key],
    });
    const own = classAOwners(platform, [palette('Ctrl-Alt-F9')]);
    const editor = mountedBindings(h, [keymap.of([{ key: 'Ctrl-Alt-F9', run: () => true }])]);
    expect(classAClash(platform, own, editor)).toEqual([]);
    const clash = classAOwners(platform, [palette('Mod-o')]);
    expect(clash.get(norm('Mod-o'))).toEqual(
      expect.arrayContaining(['global:open-vault', 'palette:simplemd.teste']),
    );
  });

  test('Classe B: duplicatas no editor montado só nas teclas declaradas; Tab só pela cadeia', async () => {
    const h = await setup({});
    const plugins = await internalContributions(h, platform);
    const all = mountedBindings(
      h,
      plugins.flatMap((p) => p.extensions),
    );
    // O `defaultKeymap` do CM tem ligações repetidas entre si (upstream, desde o r1): ele conta
    // como UMA fonte por tecla; o conflito é entre fontes (CM, MD, popup, cadeia, plugins).
    const cm = new Set<KeyBinding>(EDITOR_KEY_BINDINGS);
    const count = new Map<string, number>();
    const cmKeys = new Set<string>();
    for (const binding of all) {
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
    // Tab/Shift-Tab/Mod-]/Mod-[/Mod-Alt-→← só pela cadeia, em QUALQUER fonte do editor montado.
    expect(chainOnlyViolations(platform, all)).toEqual([]);
    // As fontes do r1/r2 continuam presentes (a descoberta não perdeu nada).
    expect(count.get(norm('Mod-b'))).toBeGreaterThan(0);
    expect(bindingsOf(markdownKeymap).length).toBeGreaterThan(0);
    expect(bindingsOf(markdownLanguageSupport()).length).toBeGreaterThan(0);
  });

  test('negativo (mutação A da G-CR): Tab ou Mod-] fora da cadeia, em qualquer fonte, reprova', async () => {
    const h = await setup({});
    const editor = mountedBindings(h, [
      keymap.of([
        { key: 'Tab', run: () => true },
        { key: 'Mod-]', run: () => true },
      ]),
    ]);
    expect(chainOnlyViolations(platform, editor)).toEqual([norm('Mod-]'), norm('Tab')].sort());
  });

  test('o contexto de host da rodada é o da produção, na plataforma da rodada', async () => {
    const h = await setup({});
    const ctx = (id: string) =>
      createInternalHostContext(id, {
        platform,
        statusBar: h.app.plugins.statusBar,
        view: () => null,
        options: () => ({ get: <T>() => undefined as T, subscribe: () => () => {} }),
        openExternal: () => {},
        readConfigFile: async () => null,
        watchConfigFiles: () => () => {},
        languageTool: h.platform.languageTool,
      });
    const outliner = ctx('simplemd.outliner');
    expect(outliner.platform).toBe(platform);
    expect(typeof outliner.editor.contextAction).toBe('function');
    expect(typeof outliner.editor.escape).toBe('function');
    expect(typeof outliner.editor.interact).toBe('function');
  });
});
