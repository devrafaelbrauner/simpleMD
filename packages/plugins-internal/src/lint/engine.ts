import { lintCounters } from './render';
import type { LintFinding, LintReply, LintRequest, lintMarkdown } from './worker';

/**
 * Onde o markdownlint roda (D-R7-F05, Q-R7-F04): (1) Web Worker de módulo de mesma origem; se ele
 * não sobe (construtor lança, `error` antes do `ready` ou nada em `READY_TIMEOUT_MS`), (2) o worker
 * clássico do mesmo arquivo; se também falhar, (3) a mesma função na thread principal em tempo
 * ocioso, com um aviso de "lint lento" (NFR-52 relatado como NÃO CUMPRIDO nesse caminho). No plano
 * C o markdownlint chega por `import()` (CR-S5-06): com o worker funcionando, o pedaço do lint na
 * thread principal não carrega o markdownlint.
 *
 * No worker fica no máximo 1 pedido em voo e 1 na espera (CR-S5-07): um pedido novo substitui o
 * que esperava (que rejeita como substituído), então uma passada lenta não acumula fila.
 */
export type EngineMode = 'module' | 'classic' | 'idle';

/** O markdownlint lançou nesta passada (texto ou configuração); as outras falhas são do motor. */
export class MarkdownlintError extends Error {
  override readonly name = 'MarkdownlintError';
}

export interface LintEngine {
  /**
   * Uma passada. Rejeita com `MarkdownlintError` se o markdownlint lançar; com outro `Error` se o
   * worker cair, o motor for descartado ou um pedido mais novo substituir este na espera.
   */
  run(text: string, config: Readonly<Record<string, unknown>>): Promise<readonly LintFinding[]>;
  /** Caminho em uso (`null` antes da 1ª passada). */
  mode(): EngineMode | null;
  dispose(): void;
}

export interface EngineDeps {
  /** Costura de teste: cria o worker do tipo pedido (padrão: `new Worker(new URL(…))`). */
  readonly createWorker?: (kind: 'module' | 'classic') => Worker;
  /** Agenda o plano C (padrão: `requestIdleCallback`, ou `setTimeout` onde não existe). */
  readonly idle?: (run: () => void) => void;
  /** O plano C entrou em uso (o plugin avisa uma vez por sessão). */
  readonly onIdleFallback?: () => void;
  readonly readyTimeoutMs?: number;
}

export const READY_TIMEOUT_MS = 4000;

function defaultCreateWorker(kind: 'module' | 'classic'): Worker {
  // Os dois literais são os padrões que o Vite reconhece e empacota (mesma origem: CSP `'self'`).
  return kind === 'module'
    ? new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
    : new Worker(new URL('./worker.ts', import.meta.url));
}

/**
 * `new Promise` (e não `Promise.withResolvers`) no arquivo todo: o alvo é Safari 16 (macOS 13),
 * que não tem `withResolvers` (Safari 17.4+) e o build não acrescenta polyfills.
 */
function defaultIdle(run: () => void): void {
  if (typeof requestIdleCallback === 'function') requestIdleCallback(run);
  else setTimeout(run, 0);
}

interface Pending {
  resolve(results: readonly LintFinding[]): void;
  reject(error: Error): void;
}

/** Pedido que espera o em voo terminar (só o mais novo fica). */
interface Queued extends Pending {
  readonly request: LintRequest;
}

export function createLintEngine(deps: EngineDeps = {}): LintEngine {
  const createWorker =
    deps.createWorker ?? (typeof Worker === 'function' ? defaultCreateWorker : null);
  const idle = deps.idle ?? defaultIdle;
  const timeout = deps.readyTimeoutMs ?? READY_TIMEOUT_MS;
  /** O pedido em voo no worker (no máximo 1). */
  const pending = new Map<number, Pending>();
  /** O pedido mais novo esperando o em voo (substitui o anterior). */
  let queued: Queued | null = null;
  let seq = 0;
  let mode: EngineMode | null = null;
  let disposed = false;
  let worker: Worker | null = null;
  /** Subida do worker em andamento (os pedidos esperam por ela). */
  let starting: Promise<Worker | null> | null = null;
  /** Tipos de worker que ainda podem ser tentados. */
  const kinds: ('module' | 'classic')[] = createWorker ? ['module', 'classic'] : [];
  /** O markdownlint na thread principal (plano C), só carregado quando o plano C entra. */
  let markdownlint: Promise<typeof lintMarkdown> | null = null;

  const failAll = (error: Error) => {
    for (const entry of pending.values()) entry.reject(error);
    pending.clear();
    queued?.reject(error);
    queued = null;
  };

  const send = (target: Worker, request: LintRequest, entry: Pending) => {
    pending.set(request.seq, entry);
    lintCounters.runs++;
    target.postMessage(request);
  };

  const onMessage = ({ data }: MessageEvent<LintReply>) => {
    if (data.type === 'ready') return;
    const entry = pending.get(data.seq);
    if (!entry) return;
    pending.delete(data.seq);
    if (data.type === 'result') entry.resolve(data.results);
    else entry.reject(new MarkdownlintError(data.error));
    if (queued && worker) {
      const next = queued;
      queued = null;
      send(worker, next.request, next);
    }
  };

  /** Sobe um worker do tipo `kind`: resolve com ele no `ready`, `null` se falhar. */
  const boot = (
    create: (kind: 'module' | 'classic') => Worker,
    kind: 'module' | 'classic',
  ): Promise<Worker | null> =>
    new Promise((resolve) => {
      let candidate: Worker;
      try {
        candidate = create(kind);
      } catch {
        resolve(null);
        return;
      }
      const timer = setTimeout(() => settle(false), timeout);
      const settle = (ok: boolean) => {
        clearTimeout(timer);
        candidate.removeEventListener('message', onReady);
        candidate.removeEventListener('error', onBootError);
        if (!ok) candidate.terminate();
        resolve(ok ? candidate : null);
      };
      const onReady = ({ data }: MessageEvent<LintReply>) => {
        if (data.type === 'ready') settle(true);
      };
      const onBootError = () => settle(false);
      candidate.addEventListener('message', onReady);
      candidate.addEventListener('error', onBootError);
    });

  const start = async (): Promise<Worker | null> => {
    while (createWorker && kinds.length > 0) {
      const kind = kinds[0] as 'module' | 'classic';
      const booted = await boot(createWorker, kind);
      if (disposed) {
        booted?.terminate();
        return null;
      }
      if (booted) {
        mode = kind;
        booted.addEventListener('message', onMessage);
        // Queda depois de subir: os pedidos em voo falham e a próxima passada sobe de novo.
        booted.addEventListener('error', () => {
          booted.terminate();
          if (worker === booted) worker = null;
          failAll(new Error('worker do lint encerrado'));
        });
        return booted;
      }
      kinds.shift();
    }
    return null;
  };

  const runIdle = (text: string, config: Readonly<Record<string, unknown>>) =>
    new Promise<readonly LintFinding[]>((resolve, reject) => {
      if (mode !== 'idle') {
        mode = 'idle';
        deps.onIdleFallback?.();
      }
      idle(() => {
        if (disposed) return;
        lintCounters.runs++;
        markdownlint ??= import('./worker').then((module) => module.lintMarkdown);
        markdownlint.then(
          (lint) => {
            try {
              resolve(lint(text, config));
            } catch (error) {
              reject(new MarkdownlintError(String(error)));
            }
          },
          (error: unknown) => {
            // O pedaço não carregou: a próxima passada tenta de novo.
            markdownlint = null;
            reject(error instanceof Error ? error : new Error(String(error)));
          },
        );
      });
    });

  return {
    async run(text, config) {
      if (disposed) throw new Error('motor do lint descartado');
      if (!worker && kinds.length > 0) {
        starting ??= start().finally(() => {
          starting = null;
        });
        worker = await starting;
      }
      if (disposed) throw new Error('motor do lint descartado');
      if (!worker) return runIdle(text, config);
      const request: LintRequest = { seq: ++seq, text, config };
      const target = worker;
      return new Promise<readonly LintFinding[]>((resolve, reject) => {
        if (pending.size === 0) {
          send(target, request, { resolve, reject });
          return;
        }
        queued?.reject(new Error('passada do lint substituída por uma mais nova'));
        queued = { request, resolve, reject };
      });
    },
    mode: () => mode,
    dispose() {
      disposed = true;
      worker?.terminate();
      worker = null;
      failAll(new Error('motor do lint descartado'));
    },
  };
}
