import type { Extension } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import {
  contextAction,
  escapeHandler,
  interactFacet,
  internalCommandsFacet,
  problemsCommandsFacet,
} from '@simplemd/core';
import type { PluginAPI } from '@simplemd/plugin-api';
import type {
  DictionaryHost,
  DictionaryLayer,
  DictionaryWriteResult,
  InternalCommand,
  InternalHostContext,
  LtMenuAction,
  LtStatus,
} from '@simplemd/plugin-api/internal/host';
import type {
  LanguageToolTransport,
  LtCheckRequest,
} from '@simplemd/plugin-api/internal/languagetool';
import type { SpellCoverage } from '@simplemd/plugin-api/internal/spell';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LtClock } from '../src/languagetool/checker';
import { createLanguageToolPlugin } from '../src/languagetool/index';
import { mountView } from './helpers';

/** Respostas gravadas do LT 6.8 real (`fixtures/lt/`, gravadas por `languagetool.record.test.ts`). */
export function fixture(name: string): string {
  return readFileSync(join(__dirname, 'fixtures/lt', name), 'utf8');
}

/** Relógio falso: timers só andam por `advance`. */
export class FakeClock implements LtClock {
  #now = 0;
  #seq = 0;
  readonly #timers = new Map<number, { at: number; callback: () => void }>();

  now(): number {
    return this.#now;
  }

  setTimeout(callback: () => void, ms: number): unknown {
    const id = ++this.#seq;
    this.#timers.set(id, { at: this.#now + ms, callback });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.#timers.delete(handle as number);
  }

  /** Avança `ms`, disparando os timers em ordem (e os criados no caminho), com microtarefas. */
  async advance(ms: number): Promise<void> {
    const end = this.#now + ms;
    for (;;) {
      await flush();
      let next: [number, { at: number; callback: () => void }] | undefined;
      for (const entry of this.#timers) if (!next || entry[1].at < next[1].at) next = entry;
      if (!next || next[1].at > end) break;
      this.#timers.delete(next[0]);
      this.#now = next[1].at;
      next[1].callback();
    }
    this.#now = end;
    await flush();
  }

  pending(): number {
    return this.#timers.size;
  }
}

export async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

export interface Call {
  readonly op: 'languages' | 'check' | 'cancel';
  readonly id?: number;
  readonly request?: LtCheckRequest;
}

type Reply = { body: string } | { error: unknown } | 'hang';

/**
 * Transporte falso controlável: `languagesReply`/`checkReply` decidem a resposta; `hang` deixa a
 * promessa pendente até `resolvePending`/`rejectPending`. Conta pedidos simultâneos em voo.
 */
export class FakeTransport implements LanguageToolTransport {
  readonly calls: Call[] = [];
  languagesReply: Reply = { body: fixture('languages.json') };
  checkReply: Reply = { body: '{"matches":[]}' };
  inFlight = 0;
  maxInFlight = 0;
  readonly #pending = new Map<
    number,
    { resolve: (body: string) => void; reject: (error: unknown) => void }
  >();

  languages(): Promise<string> {
    this.calls.push({ op: 'languages' });
    return this.#reply(this.languagesReply, null);
  }

  check(request: LtCheckRequest, id: number): Promise<string> {
    this.calls.push({ op: 'check', id, request });
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    return this.#reply(this.checkReply, id).finally(() => this.inFlight--);
  }

  cancel(id: number): Promise<void> {
    this.calls.push({ op: 'cancel', id });
    const pending = this.#pending.get(id);
    if (pending) {
      this.#pending.delete(id);
      pending.reject({ code: 'CANCELLED', message: 'cancelado' });
    }
    return Promise.resolve();
  }

  checks(): Call[] {
    return this.calls.filter((c) => c.op === 'check');
  }

  count(op: Call['op']): number {
    return this.calls.filter((c) => c.op === op).length;
  }

  resolvePending(body: string): void {
    for (const [id, p] of this.#pending) {
      this.#pending.delete(id);
      p.resolve(body);
    }
  }

  #reply(reply: Reply, id: number | null): Promise<string> {
    if (reply === 'hang') {
      const { promise, resolve, reject } = Promise.withResolvers<string>();
      if (id !== null) this.#pending.set(id, { resolve, reject });
      return promise;
    }
    return 'body' in reply ? Promise.resolve(reply.body) : Promise.reject(reply.error);
  }
}

export interface DictionaryCall {
  readonly op: 'add' | 'addAll';
  readonly layer: DictionaryLayer;
  readonly words: readonly string[];
}

/**
 * Dicionário do app falso (r32b): as duas camadas em memória com o contrato de `DictionaryHost`. O
 * formato v1 e a regra de caixa são do app (`apps/desktop/src/state/dictionary.ts`, testados lá):
 * aqui `known` compara em NFC, igual, e `addAll` recusa só palavras com espaço. A mudança publica
 * antes de a gravação resolver, como no serviço.
 */
export class FakeDictionary implements DictionaryHost {
  readonly layers: Record<DictionaryLayer, Set<string>> = { global: new Set(), folder: new Set() };
  readonly calls: DictionaryCall[] = [];
  readonly #listeners = new Set<() => void>();
  #next: DictionaryWriteResult | null = null;

  known(word: string): boolean {
    const term = word.normalize('NFC');
    return this.layers.global.has(term) || this.layers.folder.has(term);
  }

  async add(word: string, layer: DictionaryLayer): Promise<DictionaryWriteResult> {
    this.calls.push({ op: 'add', layer, words: [word] });
    return this.#write(layer, [word]);
  }

  async addAll(
    words: readonly string[],
    layer: DictionaryLayer,
  ): Promise<DictionaryWriteResult & { readonly rejected: readonly string[] }> {
    this.calls.push({ op: 'addAll', layer, words: [...words] });
    const rejected = words.filter((word) => /\s/.test(word));
    const valid = words.filter((word) => !/\s/.test(word));
    const result: DictionaryWriteResult =
      valid.length === 0 ? { status: 'exists' } : this.#write(layer, valid);
    return { ...result, rejected };
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** O próximo `add`/`addAll` devolve `result` sem gravar nada. */
  failNext(result: DictionaryWriteResult): void {
    this.#next = result;
  }

  /** Mudança vinda de fora (`.txt` novo na pasta, outra janela, carga): avisa quem assinou. */
  put(layer: DictionaryLayer, words: readonly string[]): void {
    for (const word of words) this.layers[layer].add(word.normalize('NFC'));
    this.#publish();
  }

  listeners(): number {
    return this.#listeners.size;
  }

  #write(layer: DictionaryLayer, words: readonly string[]): DictionaryWriteResult {
    const next = this.#next;
    this.#next = null;
    if (next) return next;
    const fresh = words
      .map((word) => word.normalize('NFC'))
      .filter((word) => !this.layers[layer].has(word));
    if (fresh.length === 0) return { status: 'exists' };
    for (const word of fresh) this.layers[layer].add(word);
    this.#publish();
    return { status: 'added' };
  }

  #publish(): void {
    for (const listener of [...this.#listeners]) listener();
  }
}

/**
 * Cobertura do corretor offline falsa (r35b), só leitura para o plugin, como no app; `set` faz o
 * papel do registro do `simplemd.spell`. A regra das línguas é do app (`state/spell-coverage.ts`,
 * testada lá): aqui, sem `lang` vale `pt-BR` e só a língua igual cobre.
 */
export class FakeSpellCoverage implements SpellCoverage {
  #langs: readonly string[] = [];
  readonly #listeners = new Set<() => void>();

  languageFor(fmLang: string | null): string | null {
    const wanted = fmLang ?? 'pt-BR';
    return this.#langs.includes(wanted) ? wanted : null;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** As línguas cobertas (`[]` = sem cobertura); avisa quem assinou. */
  set(langs: readonly string[]): void {
    this.#langs = [...langs];
    for (const listener of [...this.#listeners]) listener();
  }

  listeners(): number {
    return this.#listeners.size;
  }
}

export interface Mounted {
  readonly view: EditorView;
  readonly transport: FakeTransport;
  readonly clock: FakeClock;
  readonly statuses: LtStatus[];
  readonly notices: { text: string; level: string }[];
  readonly announcements: string[];
  readonly settings: Map<string, unknown>;
  readonly options: Map<string, unknown>;
  readonly dictionary: FakeDictionary;
  /** Cobertura do corretor offline (r35b): vazia ao montar, como no app sem o `simplemd.spell`. */
  readonly coverage: FakeSpellCoverage;
  readonly commands: InternalCommand[];
  status(): LtStatus | undefined;
  menu(action: LtMenuAction): void;
  setOption(key: string, value: unknown): void;
  /** `api.settings.set` rejeita com `error` (data.json inválido); `null` volta a gravar. */
  failSettings(error: Error | null): void;
  dispose(): void;
}

export interface MountOptions {
  readonly options?: Record<string, unknown>;
  readonly settings?: Record<string, unknown>;
  readonly transport?: FakeTransport;
  readonly clock?: FakeClock;
  /** Fumaça contra o servidor real: transporte HTTP e relógio de verdade no lugar dos falsos. */
  readonly real?: { readonly transport: LanguageToolTransport; readonly clock: LtClock };
  /** `false`: só o parse inicial do CM (nota longa antes do parse de fundo; CR-S8 N5). */
  readonly fullParse?: boolean;
  /** Dicionário do app (o mesmo objeto entre montagens = "reabrir" com as mesmas camadas). */
  readonly dictionary?: FakeDictionary;
  /** Cobertura já preenchida antes de ligar (o `simplemd.spell` recarregou antes do LT). */
  readonly coverage?: FakeSpellCoverage;
}

/** Monta o plugin LT num `EditorView` do jsdom, com host, API e transporte falsos. */
export function mountLt(doc: string, opts: MountOptions = {}): Mounted {
  const transport = opts.transport ?? new FakeTransport();
  const clock = opts.clock ?? new FakeClock();
  const dictionary = opts.dictionary ?? new FakeDictionary();
  const coverage = opts.coverage ?? new FakeSpellCoverage();
  const statuses: LtStatus[] = [];
  const notices: { text: string; level: string }[] = [];
  const announcements: string[] = [];
  const settings = new Map<string, unknown>(Object.entries(opts.settings ?? {}));
  let settingsError: Error | null = null;
  const options = new Map<string, unknown>(
    Object.entries({
      mode: 'auto',
      language: 'pt-BR',
      addTo: 'global',
      disabledRules: [],
      ...opts.options,
    }),
  );
  const optionListeners = new Set<(key: string) => void>();
  const actionListeners = new Set<(action: LtMenuAction) => void>();
  const commands: InternalCommand[] = [];
  const host: InternalHostContext = {
    pluginId: 'simplemd.languagetool',
    platform: 'mac',
    editor: {
      contextAction: (slot, action) => contextAction(slot, action),
      interact: (run) => interactFacet.of({ order: 10, run }),
      escape: (owner, run) => escapeHandler(owner, run),
      problems: (cmds) => problemsCommandsFacet.of(cmds),
      announce: (text) => announcements.push(text),
    },
    ltStatus: {
      set: (value) => statuses.push(value),
      clear: () => statuses.push({ state: 'manual' }),
      onAction: (listener) => {
        actionListeners.add(listener);
        return () => actionListeners.delete(listener);
      },
    },
    palette: (cmds) => {
      commands.push(...cmds);
      return internalCommandsFacet.of(cmds);
    },
    options: {
      get: <T>(key: string) =>
        (key === 'disabledRules' ? (settings.get(key) ?? options.get(key)) : options.get(key)) as T,
      subscribe: (listener) => {
        optionListeners.add(listener);
        return () => optionListeners.delete(listener);
      },
    },
    links: { openExternal: () => undefined },
    languageTool: opts.real?.transport ?? transport,
    dictionary,
    spellCoverage: coverage,
  };
  const extensions: Extension[] = [];
  const api = {
    registerEditorExtension: (ext: { source?: Extension }) => {
      if (ext.source) extensions.push(ext.source);
    },
    settings: {
      get: <T>(key: string) => structuredClone(settings.get(key)) as T | undefined,
      set: <T>(key: string, value: T) => {
        if (settingsError) return Promise.reject(settingsError);
        if (value === undefined) settings.delete(key);
        else settings.set(key, structuredClone(value));
        return Promise.resolve();
      },
    },
    ui: { notify: (text: string, level = 'info') => notices.push({ text, level }) },
  } as unknown as PluginAPI;
  const dispose = createLanguageToolPlugin(host, opts.real?.clock ?? clock)(api);
  const view = mountView(doc, extensions, { anchor: 0, fullParse: opts.fullParse ?? true });
  return {
    view,
    transport,
    dictionary,
    coverage,
    clock,
    statuses,
    notices,
    announcements,
    settings,
    options,
    commands,
    status: () => statuses[statuses.length - 1],
    menu: (action) => {
      for (const listener of actionListeners) listener(action);
    },
    setOption(key, value) {
      options.set(key, value);
      for (const listener of optionListeners) listener(key);
    },
    failSettings(error) {
      settingsError = error;
    },
    dispose: () => {
      dispose();
      view.destroy();
    },
  };
}
