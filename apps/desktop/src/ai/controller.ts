import { isolateHistory } from '@codemirror/commands';
import type { Text } from '@codemirror/state';
import type { EditorView, ViewUpdate } from '@codemirror/view';
import {
  AI_COMMAND_LABELS,
  AIError,
  chatTruncated,
  commandMessages,
  createProvider,
  PROVIDER_NAMES,
  type AiCommand,
  type AIProvider,
  type Message,
  type ProviderId,
} from '@simplemd/ai';
import { LIMIT_NOTICE_TEXT, type ResultCut } from '@simplemd/ui';
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
/** STR-133: a faixa do cartão não é mais a seleção original. */
const STALE_REASON = 'A seleção mudou; descarte e rode o comando de novo.';
/** R30-N2: "Enviar" no diálogo com a seleção já diferente do texto mostrado. */
const CHANGED_BEFORE_SEND = 'A seleção mudou com o diálogo aberto; nada foi enviado.';
/** r30: teto do histórico enviado no chat (soma dos caracteres, a mensagem nova incluída). */
export const HISTORY_MAX_CHARS = 96_000;

const count = (n: number) => n.toLocaleString('pt-BR');

/**
 * Anúncio final com o aviso de corte pelo limite do modelo (r29): o aviso vem depois de um ponto
 * ("…quatro. Resposta cortada…"; uma vírgula, ponto e vírgula ou dois-pontos no fim vira o ponto)
 * e, com resposta vazia, sem espaço duplo. O texto da resposta na tela não muda.
 */
function withLimitNotice(base: string, truncated: ResultCut): string {
  if (truncated !== 'limit') return base;
  const head = base.trimEnd().replace(/[,;:]+$/u, '');
  return `${head}${/[.!?…]$/u.test(head) ? ' ' : '. '}${LIMIT_NOTICE_TEXT}`;
}

/**
 * Histórico do chat com teto (r30): fica o trecho mais novo, sem buracos, cuja soma de caracteres
 * cabe em `max` (a última mensagem, a nova, sempre entra), começando por uma mensagem do usuário.
 * `dropped` = quantas das mais antigas ficaram de fora.
 */
export function capHistory(
  messages: readonly Message[],
  max: number,
): { messages: Message[]; dropped: number } {
  let start = messages.length;
  let total = 0;
  while (start > 0) {
    const size = messages[start - 1]!.content.length;
    if (start < messages.length && total + size > max) break;
    total += size;
    start--;
  }
  while (start < messages.length - 1 && messages[start]!.role !== 'user') start++;
  return { messages: messages.slice(start), dropped: start };
}

export type KeyStatus = 'unknown' | 'saved' | 'none';

export interface ModelsView {
  readonly provider: ProviderId | null;
  readonly state: 'idle' | 'loading' | 'ok' | 'empty' | 'fail' | 'offline';
  readonly list: readonly string[];
  /** Texto de falha (STR-126) ou "Ollama não encontrado em …". */
  readonly message: string;
}

interface ChatMessageFields {
  readonly id: number;
  readonly text: string;
  /** "IA (<provedor> · <modelo>)" (só respostas). */
  readonly heading: string;
  readonly status: 'waiting' | 'streaming' | 'done' | 'stopped' | 'error';
  /** "Aguardando resposta…" visível (passou de 150 ms sem texto). */
  readonly waiting: boolean;
  /** STR-46 (15 s sem texto). */
  readonly slow: boolean;
  readonly truncated: ResultCut;
  readonly error: string | null;
}

/** O que muda numa mensagem já na conversa (nunca o papel nem o corte do histórico). */
type ChatMessagePatch = Partial<Omit<ChatMessageFields, 'id'>>;

/**
 * Mensagem do chat. `historyDropped` (r30): mensagens antigas que ficaram fora deste envio pelo teto
 * do histórico; só um envio do usuário corta o histórico, então numa resposta é sempre 0 (o tipo
 * garante, R30-CR-NITS).
 */
export type ChatMessage =
  | (ChatMessageFields & { readonly role: 'user'; readonly historyDropped: number })
  | (ChatMessageFields & { readonly role: 'assistant'; readonly historyDropped: 0 });

/** Mensagem anterior da conversa mostrada no diálogo de consentimento (R30-N1). */
export interface ConsentHistoryEntry {
  readonly role: 'user' | 'assistant';
  /** "Você" ou "IA (<provedor> · <modelo>)": diz de onde veio a resposta (ex.: o Ollama local). */
  readonly heading: string;
  readonly text: string;
}

/** Diálogo "Enviar para …?" (r30): o 1º envio de uma pasta a um provedor de nuvem. */
export interface ConsentRequest {
  readonly id: number;
  readonly provider: KeyedProvider;
  readonly kind: 'chat' | 'command';
  /** "Chat IA" ou o rótulo do comando ("IA: Resumir seleção"). */
  readonly action: string;
  /** O que sai: a mensagem digitada ou a seleção, inteira. */
  readonly text: string;
  /**
   * Mensagens anteriores da conversa que vão junto, inteiras e em ordem (só no chat, já com o
   * teto; R30-N1): o diálogo mostra cada uma, não só quantas são.
   */
  readonly previous: readonly ConsentHistoryEntry[];
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
  readonly truncated: ResultCut;
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
  /** r30: pedido de consentimento aberto (0 pedidos de rede até "Enviar"). */
  readonly consent: ConsentRequest | null;
  /** r30: "Cancelar" no diálogo do chat devolve a mensagem ao campo (`id` muda a cada vez). */
  readonly chatRestore: { readonly id: number; readonly text: string } | null;
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
  /** r30: grava (ou revoga) o consentimento da pasta em `config.json` `ai.consent`. */
  setConsent(provider: KeyedProvider, granted: boolean): void;
}

/** Uma execução em andamento (chat ou cartão): token de geração + iterador para cancelar. */
interface Run {
  stale: boolean;
  iterator: AsyncIterator<string> | null;
  timers: unknown[];
}

/** O envio que espera o "Enviar" do diálogo (r30) e a conferência do texto mostrado (R30-N2). */
interface AfterConsent {
  readonly retry: () => Promise<void>;
  /** O `retry` ainda mandaria exatamente o que o diálogo mostra? */
  readonly holds: () => boolean;
}

/**
 * IA no app (arch-frontend r2 §11): configuração (a partir do store), estado das chaves (só
 * `has_key`), lista de modelos (só em "Atualizar lista"), o chat da sessão e o cartão de resultado
 * dos comandos sobre a seleção. TypeScript puro; a UI lê por `subscribe`/`getSnapshot`.
 *
 * Regra 1: nada toca o documento até "Substituir seleção", "Inserir abaixo" ou "Inserir no
 * cursor". R-11.9: nenhum pedido sem ação explícita (enviar, um comando, "Atualizar lista"). r30:
 * o 1º envio de texto de uma pasta a um provedor de nuvem espera o "Enviar" do diálogo.
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
    consent: null,
    chatRestore: null,
  };
  #seq = 0;
  #chatRun: Run | null = null;
  #cardRun: Run | null = null;
  #paintedFirst = false;
  /**
   * r30: o envio que espera o "Enviar" do diálogo de consentimento (refaz o pedido inteiro) e a
   * conferência de que ele ainda manda o que o diálogo mostrou (R30-N2).
   */
  #afterConsent: AfterConsent | null = null;
  /**
   * Documento ao qual `card.from/to` se referem (CR2-01): acompanha cada mudança do editor; um
   * estado trocado por inteiro (recarga do disco, `setState`) não traz mudanças para mapear a faixa,
   * então vira `null` e o cartão não aplica mais nada no documento.
   */
  #cardDoc: Text | null = null;

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
   * em log, aviso ou erro). A UI já limpou o campo antes de chamar (R-11.4, AC-11.10). `CANCELLED`
   * = o usuário recusou no diálogo nativo (APPSEC-R2-02): nada muda e nada é anunciado.
   */
  async saveKey(provider: KeyedProvider, value: string): Promise<boolean> {
    try {
      await this.#deps.platform.ai.setKey(provider, value);
    } catch (error) {
      const code =
        typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
      if (code === 'CANCELLED') return false;
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
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'CANCELLED'
      )
        return;
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
            : `Não foi possível listar os modelos: ${/[.!?…]$/.test(reason) ? reason : `${reason}.`} Use “Outro modelo…”.`,
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
  ): Promise<{ text: string; truncated: ResultCut; error: AIError | null }> {
    let text = '';
    let truncated: ResultCut = false;
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
        if (run.stale) break;
        if (step.done) {
          // r29: o valor final do iterador diz se o provedor parou pelo limite do modelo.
          if (chatTruncated(step.value)) truncated = 'limit';
          break;
        }
        text += step.value;
        if (text.length > MAX_ANSWER_CHARS) {
          text = text.slice(0, MAX_ANSWER_CHARS);
          truncated = 'chars';
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

  #updateMessage(id: number, patch: ChatMessagePatch): void {
    this.#set({
      messages: this.#snapshot.messages.map((m) => (m.id === id ? { ...m, ...patch } : m)),
    });
  }

  /**
   * r30: 1º envio de texto da pasta a um provedor de nuvem sem `ai.consent` → abre o diálogo
   * "Enviar para …?" e não faz pedido nenhum (`true`); "Enviar" refaz o envio com `retry`, se
   * `holds` disser que ele ainda manda o que o diálogo mostra. Lê o store na hora, então um
   * provedor vindo do `config.json` da pasta também passa por aqui. O Ollama (local) nunca pergunta.
   */
  #needsConsent(
    provider: ProviderId,
    request: Omit<ConsentRequest, 'id' | 'provider'>,
    after: AfterConsent,
  ): boolean {
    if (provider === 'ollama' || this.#deps.store.getState().ai.consent[provider] === true)
      return false;
    this.#afterConsent = after;
    this.#set({ consent: { ...request, id: ++this.#seq, provider } });
    return true;
  }

  /**
   * "Enviar" no diálogo: grava o consentimento da pasta e refaz o envio. Se o provedor mudou com o
   * diálogo aberto (ex.: `config.json` trocado por fora) ou o envio não mandaria mais o texto
   * mostrado (a seleção mudou, R30-N2), nada é gravado nem enviado e vale como "Cancelar"; no
   * comando, um aviso diz por quê.
   */
  async confirmConsent(): Promise<void> {
    const request = this.#snapshot.consent;
    const after = this.#afterConsent;
    if (!request || !after) return;
    if (this.#deps.store.getState().ai.provider !== request.provider) {
      this.cancelConsent();
      return;
    }
    if (!after.holds()) {
      this.cancelConsent();
      if (request.kind === 'command')
        this.#deps.store.getState().pushNotice({
          kind: 'error',
          notice: 'ai-error',
          key: 'ai-error',
          text: CHANGED_BEFORE_SEND,
        });
      return;
    }
    this.#afterConsent = null;
    this.#set({ consent: null });
    this.#deps.setConsent(request.provider, true);
    await after.retry();
  }

  /** "Cancelar" ou Esc no diálogo: 0 pedidos; no chat, a mensagem volta para o campo. */
  cancelConsent(): void {
    const request = this.#snapshot.consent;
    this.#afterConsent = null;
    if (!request) return;
    this.#set({
      consent: null,
      ...(request.kind === 'chat' ? { chatRestore: { id: request.id, text: request.text } } : {}),
    });
  }

  /** "Revogar" em Configurações → IA: o próximo envio a este provedor pergunta de novo. */
  revokeConsent(provider: KeyedProvider): void {
    this.#deps.setConsent(provider, false);
    this.#set({ live: `Autorização para ${PROVIDER_NAMES[provider]} revogada.` });
  }

  /**
   * Envia só o que o usuário digitou (D-18): nada da nota vai junto. O histórico da sessão vai com
   * teto de `HISTORY_MAX_CHARS` (r30): as mais antigas ficam de fora, com aviso na mensagem.
   */
  async send(input: string): Promise<void> {
    const ready = this.readiness();
    if (!ready.ok || this.#snapshot.streaming || this.#snapshot.consent !== null) return;
    if (input.trim() === '' || input.length > MAX_INPUT_CHARS) return;
    const sent = this.#snapshot.messages.filter((m) => m.error === null && m.text !== '');
    const { messages: history, dropped } = capHistory(
      [
        ...sent.map((m): Message => ({ role: m.role, content: m.text })),
        { role: 'user', content: input },
      ],
      HISTORY_MAX_CHARS,
    );
    const shown = this.#snapshot.messages;
    if (
      this.#needsConsent(
        ready.provider,
        {
          kind: 'chat',
          action: 'Chat IA',
          text: input,
          previous: sent.slice(dropped).map(({ role, heading, text }) => ({ role, heading, text })),
        },
        // O histórico refeito no "Enviar" é o mostrado enquanto a conversa não mudar.
        { retry: () => this.send(input), holds: () => this.#snapshot.messages === shown },
      )
    )
      return;
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
          historyDropped: dropped,
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
          historyDropped: 0,
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
    // R31-EV-N1: a recusa do diálogo nativo também sai na linha `role=status` do chat, não só
    // na mensagem.
    if (error?.transportCode === 'SEND_NOT_CONFIRMED') this.#set({ chatStatus: error.message });
    this.#set({
      streaming: false,
      chatAnnouncement: error
        ? this.#snapshot.chatAnnouncement
        : withLimitNotice(
            text.length <= ANNOUNCE_MAX
              ? `Resposta da IA: ${text}`
              : `Resposta da IA pronta (${count(text.length)} caracteres).`,
            truncated,
          ),
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

  /** Texto da seleção principal no editor agora (`null` sem editor). */
  #selectionText(): string | null {
    const view = this.#deps.editorView();
    if (!view) return null;
    const { from, to } = view.state.selection.main;
    return view.state.sliceDoc(from, to);
  }

  /** Roda um comando sobre a seleção; o resultado vai para o cartão, nunca para o documento. */
  async runCommand(command: AiCommand): Promise<void> {
    const view = this.#deps.editorView();
    const tabId = this.#deps.store.getState().activeId;
    const ready = this.readiness();
    if (!view || tabId === null || !ready.ok || this.#snapshot.consent !== null) return;
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
    if (
      this.#needsConsent(
        ready.provider,
        { kind: 'command', action: AI_COMMAND_LABELS[command], text: original, previous: [] },
        {
          retry: () => this.runCommand(command),
          // R30-N2: o "Enviar" relê a seleção; só segue se ela ainda é o texto mostrado.
          holds: () =>
            this.#deps.store.getState().activeId === tabId && this.#selectionText() === original,
        },
      )
    )
      return;
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
    this.#cardDoc = view.state.doc;
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
        cardAnnouncement: withLimitNotice(
          text.length <= ANNOUNCE_MAX
            ? `Resultado da IA: ${text}`
            : `Resultado da IA pronto (${count(text.length)} caracteres).`,
          truncated,
        ),
      });
  }

  #updateCard(id: number, patch: Partial<AiCard>): void {
    const card = this.#snapshot.card;
    if (card?.id === id) this.#set({ card: { ...card, ...patch } });
  }

  /**
   * Mudança no editor principal: a faixa original acompanha as edições (`mapPos`) e o cartão fica
   * "velho" se o texto dela mudou (UX-R2-D17; nunca substituir às cegas, regra 1). Uma mudança que
   * não parte do documento do cartão (o estado foi trocado antes) não tem como mapear a faixa.
   */
  onEditorChange(tabId: string, update: ViewUpdate): void {
    const card = this.#snapshot.card;
    if (!card || card.tabId !== tabId || !update.docChanged) return;
    if (update.startState.doc !== this.#cardDoc) {
      this.#lostRange(card);
      return;
    }
    this.#cardDoc = update.state.doc;
    const from = update.changes.mapPos(card.from, 1);
    const to = Math.max(from, update.changes.mapPos(card.to, -1));
    const stale = update.state.sliceDoc(from, to) !== card.original;
    this.#set({ card: { ...card, from, to, stale } });
  }

  /**
   * O documento da aba foi trocado por inteiro (recarga externa, "Recarregar" do conflito; CR2-01):
   * a faixa do cartão não vale mais, então "Substituir" e "Inserir abaixo" ficam bloqueados.
   */
  onTabReplaced(tabId: string): void {
    const card = this.#snapshot.card;
    if (card?.tabId === tabId) this.#lostRange(card);
  }

  #lostRange(card: AiCard): void {
    this.#cardDoc = null;
    if (!card.stale) this.#set({ card: { ...card, stale: true } });
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
    if (this.#cardDoc === null || (action === 'replace' && card.stale)) return STALE_REASON;
    return null;
  }

  /**
   * Revalida a faixa no documento que o editor mostra agora, na hora de aplicar (CR2-01): outro
   * documento ou outro texto na faixa → cartão velho e nada é aplicado.
   */
  #rangeHolds(view: EditorView, card: AiCard, action: 'replace' | 'insert'): boolean {
    if (view.state.doc !== this.#cardDoc) {
      this.#lostRange(card);
      return false;
    }
    if (action === 'replace' && view.state.sliceDoc(card.from, card.to) !== card.original) {
      this.#set({ card: { ...card, stale: true } });
      return false;
    }
    return true;
  }

  /** "Substituir seleção": uma transação, `before + result + after`; um `Mod-Z` desfaz (AC-11.12). */
  replaceSelection(): boolean {
    const card = this.#snapshot.card;
    const view = this.#deps.editorView();
    if (!card || !view || this.cardBlock('replace') !== null) return false;
    if (!this.#rangeHolds(view, card, 'replace')) return false;
    view.dispatch({
      changes: { from: card.from, to: card.to, insert: card.text },
      selection: { anchor: card.from, head: card.from + card.text.length },
      userEvent: 'input.ai',
      annotations: isolateHistory.of('full'),
    });
    this.#cardDoc = null;
    this.#set({ card: null });
    return true;
  }

  /** "Inserir abaixo": novo parágrafo depois da linha onde a seleção termina. */
  insertBelow(): boolean {
    const card = this.#snapshot.card;
    const view = this.#deps.editorView();
    if (!card || !view || this.cardBlock('insert') !== null) return false;
    if (!this.#rangeHolds(view, card, 'insert')) return false;
    const line = view.state.doc.lineAt(Math.min(card.to, view.state.doc.length));
    const insert = `\n\n${card.text}`;
    view.dispatch({
      changes: { from: line.to, insert },
      selection: { anchor: line.to + insert.length },
      userEvent: 'input.ai',
      annotations: isolateHistory.of('full'),
    });
    this.#cardDoc = null;
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
    this.#cardDoc = null;
    this.#set({ card: null });
  }

  /** Pasta fechada/trocada: para tudo, fecha o diálogo de consentimento e esquece a conversa. */
  reset(): void {
    this.stop();
    this.discardCard();
    this.#afterConsent = null;
    this.#set({
      messages: [],
      chatStatus: '',
      consent: null,
      chatRestore: null,
      models: { ...this.#snapshot.models, state: 'idle', list: [] },
    });
  }
}
