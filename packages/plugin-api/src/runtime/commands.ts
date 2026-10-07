import type { KeyBinding } from '@codemirror/view';
import type { Unsubscribe } from '../types';
import { Observable } from './observable';

/**
 * Comandos do app (arch-frontend r2 §4.1): embutidos, de plugin e (etapa 11) de IA, numa única
 * lista lida pela paleta. Ids embutidos têm prefixo `app:`/`export:`/`ai:`/`panel:` e nunca colidem
 * com os de plugin, que sempre contêm um ponto (`<pluginId>:<id>`).
 */
export interface AppCommand {
  readonly id: string;
  /** Texto da paleta (pt-BR). */
  readonly title: string;
  readonly source: 'builtin' | 'plugin' | 'ai';
  readonly pluginId?: string;
  /** Atalho ligado, em notação do CodeMirror (`Mod-Shift-h`), só quando de fato ligado. */
  readonly hotkey?: string;
  /** Segunda linha (ex.: "para <idioma>"). */
  readonly detail?: string;
  isEnabled?(): true | { readonly reason: string };
  run(): void | Promise<void>;
}

export type Platform = 'mac' | 'other';

/** Grupo na ordem da paleta com a busca vazia (arch-ux r2 §3.6). */
function group(command: AppCommand): number {
  if (command.id.startsWith('app:')) return 0;
  if (command.id.startsWith('export:')) return 1;
  if (command.id.startsWith('ai:')) return 2;
  if (command.id.startsWith('panel:')) return 4;
  return 3;
}

const collator = new Intl.Collator('pt-BR', { sensitivity: 'base' });

export class CommandRegistry extends Observable<readonly AppCommand[]> {
  readonly #commands = new Map<string, AppCommand>();

  constructor() {
    super([]);
  }

  /** Lança se o id já existe. */
  register(command: AppCommand): Unsubscribe {
    if (this.#commands.has(command.id)) throw new Error(`comando “${command.id}” já registrado`);
    this.#commands.set(command.id, command);
    this.#emit();
    return () => {
      if (this.#commands.get(command.id) === command) {
        this.#commands.delete(command.id);
        this.#emit();
      }
    };
  }

  get(id: string): AppCommand | undefined {
    return this.#commands.get(id);
  }

  get size(): number {
    return this.#commands.size;
  }

  /**
   * Ordem da paleta com a busca vazia: `app:` (ordem de registro), `export:`, `ai:`, comandos de
   * plugin por rótulo, painéis de plugin por rótulo.
   */
  #emit(): void {
    const all = [...this.#commands.values()];
    const order = new Map(all.map((command, index) => [command, index]));
    all.sort((a, b) => {
      const ga = group(a);
      const gb = group(b);
      if (ga !== gb) return ga - gb;
      if (ga >= 3) return collator.compare(a.title, b.title);
      return (order.get(a) ?? 0) - (order.get(b) ?? 0);
    });
    this.publish(all);
  }
}

/**
 * Forma canônica de um atalho em notação do CodeMirror (`Mod` resolvido pela plataforma; ordem
 * `Shift-Meta-Ctrl-Alt-<tecla>`; letra única em minúscula), a mesma que o `keymap` casa. Lança
 * `TypeError` para um modificador desconhecido.
 */
export function normalizeHotkey(key: string, platform: Platform): string {
  const parts = key.split(/-(?!$)/);
  let name = parts[parts.length - 1] ?? '';
  if (name.length === 1) name = name.toLowerCase();
  let alt = false;
  let ctrl = false;
  let meta = false;
  let shift = false;
  for (const mod of parts.slice(0, -1)) {
    if (/^(cmd|meta|m)$/i.test(mod)) meta = true;
    else if (/^a(lt)?$/i.test(mod)) alt = true;
    else if (/^(c|ctrl|control)$/i.test(mod)) ctrl = true;
    else if (/^s(hift)?$/i.test(mod)) shift = true;
    else if (/^mod$/i.test(mod)) {
      if (platform === 'mac') meta = true;
      else ctrl = true;
    } else throw new TypeError(`atalho inválido: “${key}”`);
  }
  if (name === '') throw new TypeError(`atalho inválido: “${key}”`);
  if (alt) name = `Alt-${name}`;
  if (ctrl) name = `Ctrl-${name}`;
  if (meta) name = `Meta-${name}`;
  if (shift) name = `Shift-${name}`;
  return name;
}

/** Atalhos embutidos de R-6.9 + os de UX (C-R2-3). */
const BUILTIN_KEYS = [
  'Mod-b',
  'Mod-i',
  'Mod-k',
  'Mod-w',
  'Mod-,',
  'Mod-o',
  'Mod-Shift-p',
  'Mod-p',
  'Ctrl-Tab',
  'Ctrl-Shift-Tab',
  'Tab',
  'Shift-Tab',
  'Escape',
  'Enter',
  'Ctrl-Space',
  'Mod-Shift-Space',
  'Mod-Shift-l',
  'Mod-Shift-a',
];

/**
 * Conjunto de conflito dos atalhos de plugin: a lista de R-6.9, as teclas de UX (`Mod-Shift-L`,
 * `Mod-Shift-A`, `Mod-Shift-Space`; C-R2-3) e toda tecla ligada no editor principal pelos keymaps
 * padrão/histórico do CodeMirror (`editorBindings`; arch-ux CF-R2-2: um plugin nunca rouba o desfazer).
 */
export function builtinHotkeys(
  editorBindings: readonly KeyBinding[],
  platform: Platform,
): ReadonlySet<string> {
  const keys = new Set<string>();
  const add = (key: string | undefined) => {
    if (key) keys.add(normalizeHotkey(key, platform));
  };
  for (const key of BUILTIN_KEYS) add(key);
  for (const binding of editorBindings) {
    const key = (platform === 'mac' ? binding.mac : (binding.win ?? binding.linux)) ?? binding.key;
    add(key);
    if (binding.shift && key) add(`Shift-${key}`);
  }
  return keys;
}
