/**
 * API de plugins v1 do simpleMD: exatamente PLANO §4.1 (aprovada pelo usuário antes da etapa 6).
 * Nenhum membro pode ser acrescentado, renomeado ou removido de `PluginAPI`: isso quebraria
 * plugins. Onde §4.1 não fixou um tipo, ele foi preenchido pela decisão D-7 (product r2) e faz
 * parte do contrato v1. Este arquivo só declara tipos (sem código de execução).
 */
import type { CompletionSource as CMCompletionSource } from '@codemirror/autocomplete';
import type { Extension } from '@codemirror/state';

/** Extensão do CodeMirror 6 (`Extension` de `@codemirror/state`, módulo do host). */
export type CMExtension = Extension;
/** Fonte de sugestões do `@codemirror/autocomplete` (módulo do host). */
export type CompletionSource = CMCompletionSource;
export type Unsubscribe = () => void;

declare const milkdownPluginBrand: unique symbol;
/**
 * Reservado para o modo WYSIWYG (etapa 15); aceito e ignorado hoje.
 * Tipo opaco e sem dependências: o plugin guarda um valor que só o motor WYSIWYG vai ler.
 */
export type MilkdownPlugin = { readonly [milkdownPluginBrand]: 'MilkdownPlugin' };

export interface PluginManifest {
  /** Ex.: "com.exemplo.calc"; igual ao nome da pasta. */
  id: string;
  name: string;
  /** SemVer. */
  version: string;
  minAppVersion: string;
  /** Ex.: "main.js". */
  main: string;
  description?: string;
}

/** Os 3 eventos da API v1. */
export type PluginEventName = 'file:open' | 'file:save' | 'vault:change';

/** Carga de cada evento (D-7, R-6.13); caminhos relativos ao vault, com `/`. */
export interface PluginEventMap {
  'file:open': { readonly path: string };
  'file:save': { readonly path: string; readonly mtime: number };
  'vault:change': { readonly paths: readonly string[] };
}

export type NotifyLevel = 'info' | 'warn' | 'error';

export interface PluginAPI {
  registerCommand(id: string, cmd: { name: string; hotkey?: string; run(): void }): void;
  registerEditorExtension(ext: {
    source?: CMExtension;
    /** Reservado para o modo WYSIWYG (etapa 15); aceito e ignorado hoje. */
    wysiwyg?: MilkdownPlugin;
  }): void;
  registerPanel(id: string, panel: { title: string; render(el: HTMLElement): void }): void;
  registerCompletionSource(src: CompletionSource): void;
  on<E extends PluginEventName>(evt: E, handler: (e: PluginEventMap[E]) => void): Unsubscribe;
  vault: {
    read(path: string): Promise<string>;
    write(path: string, text: string): Promise<void>;
    list(): Promise<string[]>;
  };
  settings: { get<T>(key: string): T | undefined; set<T>(key: string, value: T): Promise<void> };
  ui: { notify(msg: string, level?: NotifyLevel): void };
}

/** O `main.js` do plugin exporta por padrão: */
export type PluginActivate = (api: PluginAPI) => void | (() => void);
