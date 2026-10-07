import { isolateHistory } from '@codemirror/commands';
import type { EditorView, ViewUpdate } from '@codemirror/view';
import {
  AI_COMMAND_LABELS,
  AIError,
  commandMessages,
  createProvider,
  PROVIDER_NAMES,
  type AiCommand,
  type AIProvider,
  type Message,
  type ProviderId,
} from '@simplemd/ai';
import type { AppPlatform, KeyedProvider } from '../platform/types';
import type { AppStore } from '../state/store';

/** Limites (NFR-35): mensagem/seleção ≤ 32.000 caracteres; resposta ≤ 200.000. */
export const MAX_INPUT_CHARS = 32_000;
export const MAX_ANSWER_CHARS = 200_000;
/** "Aguardando resposta…" depois de 150 ms; STR-46 depois de 15 s (DESIGN §9.1). */
export const WAITING_AFTER_MS = 150;
export const SLOW_AFTER_MS = 15_000;
/** Resposta anunciada por inteiro até 2.000 caracteres (CF-R2-6). */
const ANNOUNCE_MAX = 2_000;

const count = (n: number) => n.toLocaleString('pt-BR');

export type KeyStatus = 'unknown' | 'saved' | 'none';

export interface ModelsView {
  readonly provider: ProviderId | null;
  readonly state: 'idle' | 'loading' | 'ok' | 'empty' | 'fail' | 'offline';
  readonly list: readonly string[];
  /** Texto de falha (STR-126) ou "Ollama não encontrado em …". */
  readonly message: string;
}

export interface ChatMessage {
  readonly id: number;
  readonly role: 'user' | 'assistant';
  readonly text: string;
  /** "IA (<provedor> · <modelo>)" (só respostas). */
  readonly heading: string;
  readonly status: 'waiting' | 'streaming' | 'done' | 'stopped' | 'error';
  /** "Aguardando resposta…" visível (passou de 150 ms sem texto). */
  readonly waiting: boolean;
  /** STR-46 (15 s sem texto). */
  readonly slow: boolean;
  readonly truncated: boolean;
  readonly error: string | null;
}

export interface AiCard {
  readonly id: number;
  readonly command: AiCommand;
  /** "<comando> · <provedor> (<modelo>)". */
  readonly title: string;
  readonly tabId: string;
  readonly tabName: string;
  readonly from: number;
  readonly to: number;
  readonly original: string;
  readonly text: string;
  readonly status: 'streaming' | 'done' | 'error';
  readonly error: string | null;
  readonly truncated: boolean;
  /** O texto da seleção original mudou depois do comando (UX-R2-D17). */
  readonly stale: boolean;
}

export interface AiSnapshot {
  readonly keys: Readonly<Record<KeyedProvider, KeyStatus>>;
  readonly keyErrors: Readonly<Partial<Record<KeyedProvider, string>>>;
  readonly models: ModelsView;
  readonly messages: readonly ChatMessage[];
  readonly streaming: boolean;
  /** Linha `role=status` do chat ("Resposta inserida em …", "Resultado copiado."). */
  readonly chatStatus: string;
  /** Anunciador polido do chat: muda uma vez por resposta terminada (AC-11.18). */
  readonly chatAnnouncement: string;
  readonly card: AiCard | null;
  readonly cardAnnouncement: string;
  /** Região viva local do L2 (chave salva/removida, lista de modelos; UX-R2-D21). */
  readonly live: string;
}

export type Readiness =
  | { readonly ok: true; readonly provider: ProviderId; readonly model: string }
  | {
      readonly ok: false;
      readonly kind: 'noprovider' | 'nokey' | 'nomodel';
      readonly message: string;
    };

/** STR-125: falha ao salvar a chave, por código nativo (nunca o valor). */
const KEY_SAVE_ERRORS: Record<string, string> = {
  KEYCHAIN_DENIED: 'Acesso ao keychain negado. A chave não foi salva.',
  KEYCHAIN_UNAVAILABLE: 'Keychain do sistema indisponível. A chave não foi salva.',
  INVALID_KEY_FORMAT: 'Chave em formato inválido. A chave não foi salva.',
};
const KEY_SAVE_OTHER = 'Não foi possível salvar a chave no keychain.';

export interface AiControllerDeps {
  readonly platform: AppPlatform;
  readonly store: AppStore;
  /** O `EditorView` principal (mostra a aba ativa), ou `null` antes da montagem. */
  editorView(): EditorView | null;
  /** Nome da aba (para "Volte para a aba “…”" e "Resposta inserida em “…”"). */
  tabName(id: string): string;
  /** Agenda a publicação no próximo quadro (rAF no app; imediato nos testes). */
  schedule?(flush: () => void): void;
  readonly setTimeout?: (fn: () => void, ms: number) => unknown;
  readonly clearTimeout?: (handle: unknown) => void;
  /** Copiar para a área de transferência. */
  copy(text: string): Promise<void>;
}

/** Uma execução em andamento (chat ou cartão): token de geração + iterador para cancelar. */
interface Run {
  stale: boolean;
  iterator: AsyncIterator<string> | null;
  timers: unknown[];
}

/**
 * IA no app (arch-frontend r2 §11): configuração (a partir do store), estado das chaves (só
 * `has_key`), lista de modelos (só em "Atualizar lista"), o chat da sessão e o cartão de resultado
 * dos comandos sobre a seleção. TypeScript puro; a UI lê por `subscribe`/`getSnapshot`.
 *
 * Regra 1: nada toca o documento até "Substituir seleção", "Inserir abaixo" ou "Inserir no
 * cursor". R-11.9: nenhum pedido sem ação explícita (enviar, um comando, "Atualizar lista").
 */
export class AiController {
  readonly #deps: AiControllerDeps;
  readonly #listeners = new Set<() => void>();
  #snapshot: AiSnapshot = {
    keys: { openai: 'unknown', anthropic: 'unknown' },
    keyErrors: {},
    models: { provider: null, state: 'idle', list: [], message: '' },
    messages: [],
    streaming: false,
    chatStatus: '',
    chatAnnouncement: '',
    card: null,
    cardAnnouncement: '',
    live: '',
  };
  #seq = 0;
  #chatRun: Run | null = null;
  #cardRun: Run | null = null;
  #paintedFirst = false;

  constructor(deps: AiControllerDeps) {
    this.#deps = deps;
    // Trocar de provedor zera a lista (0 pedidos: R-11.9; a lista só vem do botão).
    let provider = deps.store.getState().ai.provider;
    deps.store.subscribe((state) => {
      if (state.ai.provider === provider) return;
      provider = state.ai.provider;
      this.#set({ models: { provider, state: 'idle', list: [], message: '' } });
    });
  }

  readonly subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  readonly getSnapshot = () => this.#snapshot;

  #set(patch: Partial<AiSnapshot>): void {
    this.#snapshot = { ...this.#snapshot, ...patch };
    for (const listener of [...this.#listeners]) listener();
  }

  #provider(id: ProviderId): AIProvider {
    return createProvider(id, this.#deps.platform.ai.transport, {
      ollamaUrl: this.#deps.store.getState().ai.ollamaUrl,
    });
  }

  #timeout(fn: () => void, ms: number): unknown {
    return (this.#deps.setTimeout ?? ((f, t) => setTimeout(f, t)))(fn, ms);
  }

  #clear(handle: unknown): void {
    (this.#deps.clearTimeout ?? ((h) => clearTimeout(h as number)))(handle);
  }

  #schedule(flush: () => void): void {
    const frame =
      typeof requestAnimationFrame === 'function'
        ? (f: () => void) => requestAnimationFrame(f)
        : (f: () => void) => this.#timeout(f, 16);
    (this.#deps.schedule ?? frame)(flush);
  }

  // ---- Configuração e chaves -------------------------------------------------------------

  /** Provedor pronto: escolhido, com chave (nuvem) e com modelo (STR-131). */
  readiness(): Readiness {
    const { provider, models } = this.#deps.store.getState().ai;
    if (provider === null)
      return {
        ok: false,
        kind: 'noprovider',
        message: 'Configure um provedor em Configurações → IA.',
      };
    if (provider !== 'ollama' && this.#snapshot.keys[provider] === 'none')
      return { ok: false, kind: 'nokey', message: `Sem chave para ${PROVIDER_NAMES[provider]}.` };
    const model = models[provider];
    if (!model)
      return { ok: false, kind: 'nomodel', message: 'Escolha um modelo em Configurações → IA.' };
    return { ok: true, provider, model };
  }

  /** Estado das chaves pelo keychain (`has_key`; nenhum valor sai do Rust). */
  async refreshKeys(): Promise<void> {
    const keys = { ...this.#snapshot.keys };
    await Promise.all(
      (['openai', 'anthropic'] as const).map(async (provider) => {
        try {
          keys[provider] = (await this.#deps.platform.ai.hasKey(provider)) ? 'saved' : 'none';
        } catch {
          keys[provider] = 'unknown';
        }
      }),
    );
    this.#set({ keys });
  }

  /**
   * "Salvar no keychain": o valor vai direto para o Rust e não é guardado aqui (nem no store, nem
   * em log, aviso ou erro). A UI já limpou o campo antes de chamar (R-11.4, AC-11.10).
   */
  async saveKey(provider: KeyedProvider, value: string): Promise<boolean> {
    try {
      await this.#deps.platform.ai.setKey(provider, value);
    } catch (error) {
      const code =
        typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
      this.#set({
        keyErrors: {
          ...this.#snapshot.keyErrors,
          [provider]: KEY_SAVE_ERRORS[code] ?? KEY_SAVE_OTHER,
        },
      });
      return false;
    }
    this.#set({
      keys: { ...this.#snapshot.keys, [provider]: 'saved' },
      keyErrors: { ...this.#snapshot.keyErrors, [provider]: undefined },
      live: 'Chave salva',
    });
    return true;
  }

  async removeKey(provider: KeyedProvider): Promise<void> {
    try {
      await this.#deps.platform.ai.deleteKey(provider);
    } catch {
      this.#set({ keyErrors: { ...this.#snapshot.keyErrors, [provider]: KEY_SAVE_OTHER } });
      return;
    }
    this.#set({
      keys: { ...this.#snapshot.keys, [provider]: 'none' },
      keyErrors: { ...this.#snapshot.keyErrors, [provider]: undefined },
      live: 'Sem chave',
    });
  }

  /** "Atualizar lista" (a única origem de `listModels`, UX-R2-D19). */
  async refreshModels(): Promise<void> {
    const { provider } = this.#deps.store.getState().ai;
    if (provider === null) return;
    if (provider !== 'ollama' && this.#snapshot.keys[provider] === 'none') return;
    this.#set({ models: { provider, state: 'loading', list: [], message: '' } });
    try {
      const list = await this.#provider(provider).listModels();
      if (this.#deps.store.getState().ai.provider !== provider) return;
      this.#set({
        models: { provider, state: list.length > 0 ? 'ok' : 'empty', list, message: '' },
        live: list.length > 0 ? 'Lista de modelos atualizada.' : 'Nenhum modelo encontrado.',
      });
    } catch (error) {
      if (this.#deps.store.getState().ai.provider !== provider) return;
      const offline = error instanceof AIError && error.code === 'OLLAMA_NOT_FOUND';
      const reason = error instanceof AIError ? error.message : 'Erro do provedor';
      this.#set({
        models: {
          provider,
          state: offline ? 'offline' : 'fail',
          list: [],
          message: offline
            ? reason
            : `Não foi possível listar os modelos: ${reason}. Use “Outro modelo…”.`,
        },
      });
    }
  }

  // ---- Streaming comum -------------------------------------------------------------------

  /**
   * Lê o fluxo publicando no máximo uma vez por quadro (NFR-33). Um `Run` velho (Parar, Descartar,
   * novo comando) descarta tudo o que chegar depois, antes de tocar o estado.
   */
  async #consume(
    run: Run,
    iterable: AsyncIterable<string>,
    publish: (text: string) => void,
  ): Promise<{ text: string; truncated: boolean; error: AIError | null }> {
    let text = '';
    let truncated = false;
    let pending = false;
    /** O fluxo acabou: um quadro agendado não pode mais publicar (o estado final já foi escrito). */
    let finished = false;
    const flush = () => {
      pending = false;
      if (run.stale || finished) return;
      publish(text);
      if (!this.#paintedFirst && text !== '') {
        this.#paintedFirst = true;
        this.#deps.platform.log('ai:first-paint');
      }
    };
    const iterator = iterable[Symbol.asyncIterator]();
    run.iterator = iterator;
    try {
      for (;;) {
        const step = await iterator.next();
        if (run.stale || step.done) break;
        text += step.value;
        if (text.length > MAX_ANSWER_CHARS) {
          text = text.slice(0, MAX_ANSWER_CHARS);
          truncated = true;
          void iterator.return?.();
          break;
        }
        if (!pending) {
          pending = true;
          this.#schedule(flush);
        }
      }
    } catch (error) {
      finished = true;
      if (run.stale) return { text, truncated, error: null };
      const aiError =
        error instanceof AIError ? error : new AIError('TRANSPORT', 'openai', 'Erro do provedor');
      if (aiError.transportCode === 'CANCELLED') return { text, truncated, error: null };
      return { text, truncated, error: aiError };
    }
    finished = true;
    if (text !== '' && !this.#paintedFirst) {
      this.#paintedFirst = true;
      this.#deps.platform.log('ai:first-paint');
    }
    return { text, truncated, error: null };
  }

  #stopRun(run: Run | null): void {
    if (!run) return;
    run.stale = true;
    for (const timer of run.timers) this.#clear(timer);
    void run.iterator?.return?.();
  }

  // ---- Chat (R-11.7) ----------------------------------------------------------------------

  #updateMessage(id: number, patch: Partial<ChatMessage>): void {
    this.#set({
      messages: this.#snapshot.messages.map((m) => (m.id === id ? { ...m, ...patch } : m)),
    });
  }

  /** Envia só o que o usuário digitou (D-18): nada da nota vai junto. */
  async send(input: string): Promise<void> {
    const ready = this.readiness();
    if (!ready.ok || this.#snapshot.streaming) return;
    if (input.trim() === '' || input.length > MAX_INPUT_CHARS) return;
    const history: Message[] = this.#snapshot.messages
      .filter((m) => m.error === null && m.text !== '')
      .map((m) => ({ role: m.role, content: m.text }));
    history.push({ role: 'user', content: input });
    const userId = ++this.#seq;
    const answerId = ++this.#seq;
    const heading = `IA (${PROVIDER_NAMES[ready.provider]} · ${ready.model})`;
    this.#set({
      streaming: true,
      chatStatus: '',
      messages: [
        ...this.#snapshot.messages,
        {
          id: userId,
          role: 'user',
          text: input,
          heading: 'Você',
          status: 'done',
          waiting: false,
          slow: false,
          truncated: false,
          error: null,
        },
        {
          id: answerId,
          role: 'assistant',
          text: '',
          heading,
          status: 'waiting',
          waiting: false,
          slow: false,
          truncated: false,
          error: null,
        },
      ],
    });
    const run: Run = { stale: false, iterator: null, timers: [] };
    this.#chatRun = run;
    this.#paintedFirst = false;
    const stillWaiting = () =>
      !run.stale && this.#snapshot.messages.find((m) => m.id === answerId)?.text === '';
    run.timers.push(
      this.#timeout(() => {
        if (stillWaiting()) this.#updateMessage(answerId, { waiting: true });
      }, WAITING_AFTER_MS),
      this.#timeout(() => {
        if (stillWaiting()) this.#updateMessage(answerId, { slow: true });
      }, SLOW_AFTER_MS),
    );
    const result = await this.#consume(
      run,
      this.#provider(ready.provider).chat(history, { model: ready.model, stream: true }),
      (text) =>
        this.#updateMessage(answerId, { text, status: 'streaming', waiting: false, slow: false }),
    );
    if (run.stale) return;
    for (const timer of run.timers) this.#clear(timer);
    this.#chatRun = null;
    const { text, truncated, error } = result;
    this.#updateMessage(answerId, {
      text,
      status: error ? 'error' : 'done',
      waiting: false,
      slow: false,
      truncated,
      error: error?.message ?? null,
    });
    this.#set({
      streaming: false,
      chatAnnouncement: error
        ? this.#snapshot.chatAnnouncement
        : text.length <= ANNOUNCE_MAX
          ? `Resposta da IA: ${text}`
          : `Resposta da IA pronta (${count(text.length)} caracteres).`,
    });
  }

  /** "Parar": o token fica velho ANTES do cancelamento — 0 atualizações depois (AC-11.11). */
  stop(): void {
    const run = this.#chatRun;
    if (!run) return;
    this.#chatRun = null;
    this.#stopRun(run);
    const last = this.#snapshot.messages.at(-1);
    if (last && last.role === 'assistant')
      this.#updateMessage(last.id, { status: 'stopped', waiting: false, slow: false });
    this.#set({ streaming: false });
  }

  /** "Limpar conversa": para um fluxo em andamento e esvazia (só memória da sessão). */
  clear(): void {
    this.stop();
    this.#set({ messages: [], chatStatus: '' });
  }

  /** "Inserir no cursor": a resposta exata na posição do cursor da aba ativa, desfazível. */
  insertAnswer(id: number): void {
    const message = this.#snapshot.messages.find((m) => m.id === id);
    const view = this.#deps.editorView();
    const tabId = this.#deps.store.getState().activeId;
    if (!message || !view || tabId === null || message.text === '') return;
    const at = view.state.selection.main.head;
    view.dispatch({
      changes: { from: at, insert: message.text },
      selection: { anchor: at + message.text.length },
      userEvent: 'input.ai',
      annotations: isolateHistory.of('full'),
    });
    this.#set({ chatStatus: `Resposta inserida em “${this.#deps.tabName(tabId)}”.` });
  }

  async copyAnswer(id: number): Promise<void> {
    const message = this.#snapshot.messages.find((m) => m.id === id);
    if (!message) return;
    await this.#deps.copy(message.text);
    this.#set({ chatStatus: 'Resultado copiado.' });
  }

  // ---- Comandos sobre a seleção e cartão C5 (R-11.8) -------------------------------------

  /** Primeiro motivo que impede um comando `ai:*` (STR-58), ou `true`. */
  commandEnabled(): true | { reason: string } {
    const view = this.#deps.editorView();
    if (!this.#deps.store.getState().activeId || !view)
      return { reason: 'Abra uma nota e selecione um texto.' };
    if (view.state.selection.main.empty) return { reason: 'Selecione um texto no editor.' };
    if (!this.readiness().ok) return { reason: 'Configure a IA em Configurações → IA.' };
    return true;
  }

  /** Roda um comando sobre a seleção; o resultado vai para o cartão, nunca para o documento. */
  async runCommand(command: AiCommand): Promise<void> {
    const view = this.#deps.editorView();
    const tabId = this.#deps.store.getState().activeId;
    const ready = this.readiness();
    if (!view || tabId === null || !ready.ok) return;
    const { from, to } = view.state.selection.main;
    if (from === to) return;
    const original = view.state.sliceDoc(from, to);
    if (original.length > MAX_INPUT_CHARS) {
      // AC-11.13: aviso e 0 pedidos.
      this.#deps.store.getState().pushNotice({
        kind: 'error',
        notice: 'ai-too-long',
        key: 'ai-too-long',
        text: 'A seleção tem mais de 32.000 caracteres; selecione menos texto.',
      });
      return;
    }
    this.#stopRun(this.#cardRun);
    const run: Run = { stale: false, iterator: null, timers: [] };
    this.#cardRun = run;
    this.#paintedFirst = false;
    const card: AiCard = {
      id: ++this.#seq,
      command,
      title: `${AI_COMMAND_LABELS[command]} · ${PROVIDER_NAMES[ready.provider]} (${ready.model})`,
      tabId,
      tabName: this.#deps.tabName(tabId),
      from,
      to,
      original,
      text: '',
      status: 'streaming',
      error: null,
      truncated: false,
      stale: false,
    };
    this.#set({ card });
    const messages = commandMessages(command, original, this.#deps.store.getState().ai.language);
    const result = await this.#consume(
      run,
      this.#provider(ready.provider).chat(messages, { model: ready.model, stream: true }),
      (text) => this.#updateCard(card.id, { text }),
    );
    if (run.stale) return;
    this.#cardRun = null;
    const { text, truncated, error } = result;
    this.#updateCard(card.id, {
      text,
      truncated,
      status: error ? 'error' : 'done',
      error: error?.message ?? null,
    });
    if (!error)
      this.#set({
        cardAnnouncement:
          text.length <= ANNOUNCE_MAX
            ? `Resultado da IA: ${text}`
            : `Resultado da IA pronto (${count(text.length)} caracteres).`,
      });
  }

  #updateCard(id: number, patch: Partial<AiCard>): void {
    const card = this.#snapshot.card;
    if (card?.id === id) this.#set({ card: { ...card, ...patch } });
  }

  /**
   * Mudança no editor principal: a faixa original acompanha as edições (`mapPos`) e o cartão fica
   * "velho" se o texto dela mudou (UX-R2-D17; nunca substituir às cegas, regra 1).
   */
  onEditorChange(tabId: string, update: ViewUpdate): void {
    const card = this.#snapshot.card;
    if (!card || card.tabId !== tabId || !update.docChanged) return;
    const from = update.changes.mapPos(card.from, 1);
    const to = Math.max(from, update.changes.mapPos(card.to, -1));
    const stale = update.state.sliceDoc(from, to) !== card.original;
    this.#set({ card: { ...card, from, to, stale } });
  }

  /** Motivo de uma ação do cartão desabilitada (STR-133), ou `null`. */
  cardBlock(action: 'replace' | 'insert' | 'copy'): string | null {
    const card = this.#snapshot.card;
    if (!card) return '';
    if (card.status === 'streaming') return 'Aguarde a resposta terminar.';
    if (action === 'copy') return null;
    if (card.status === 'error') return 'error';
    if (this.#deps.store.getState().activeId !== card.tabId)
      return `Volte para a aba “${card.tabName}” para aplicar.`;
    if (action === 'replace' && card.stale)
      return 'A seleção mudou; descarte e rode o comando de novo.';
    return null;
  }

  /** "Substituir seleção": uma transação, `before + result + after`; um `Mod-Z` desfaz (AC-11.12). */
  replaceSelection(): boolean {
    const card = this.#snapshot.card;
    const view = this.#deps.editorView();
    if (!card || !view || this.cardBlock('replace') !== null) return false;
    view.dispatch({
      changes: { from: card.from, to: card.to, insert: card.text },
      selection: { anchor: card.from, head: card.from + card.text.length },
      userEvent: 'input.ai',
      annotations: isolateHistory.of('full'),
    });
    this.#set({ card: null });
    return true;
  }

  /** "Inserir abaixo": novo parágrafo depois da linha onde a seleção termina. */
  insertBelow(): boolean {
    const card = this.#snapshot.card;
    const view = this.#deps.editorView();
    if (!card || !view || this.cardBlock('insert') !== null) return false;
    const line = view.state.doc.lineAt(Math.min(card.to, view.state.doc.length));
    const insert = `\n\n${card.text}`;
    view.dispatch({
      changes: { from: line.to, insert },
      selection: { anchor: line.to + insert.length },
      userEvent: 'input.ai',
      annotations: isolateHistory.of('full'),
    });
    this.#set({ card: null });
    return true;
  }

  async copyCard(): Promise<void> {
    const card = this.#snapshot.card;
    if (!card || this.cardBlock('copy') !== null) return;
    await this.#deps.copy(card.text);
    this.#deps.store.getState().pushNotice({
      kind: 'info',
      notice: 'ai-copied',
      key: 'ai-copied',
      text: 'Resultado copiado.',
    });
  }

  /** "Descartar" (ou Esc no cartão): aborta o fluxo e fecha; o documento não muda. */
  discardCard(): void {
    this.#stopRun(this.#cardRun);
    this.#cardRun = null;
    this.#set({ card: null });
  }

  /** Pasta fechada/trocada: para tudo e esquece a conversa (só da sessão). */
  reset(): void {
    this.stop();
    this.discardCard();
    this.#set({
      messages: [],
      chatStatus: '',
      models: { ...this.#snapshot.models, state: 'idle', list: [] },
    });
  }
}
