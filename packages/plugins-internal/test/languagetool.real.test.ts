import { spawn, type ChildProcess } from 'node:child_process';
import type {
  LanguageToolTransport,
  LtCheckRequest,
} from '@simplemd/plugin-api/internal/languagetool';
import { afterAll, describe, expect, test } from 'vitest';
import { ltField } from '../src/languagetool/field';
import { destroyViews } from './helpers';
import { mountLt } from './lt-harness';

/**
 * Fumaça de desenvolvedor contra um LanguageTool REAL (r7 sprint §7.7, C-2; parte sem GUI do
 * AC-I8.12). Fora da suíte padrão: só com `SIMPLEMD_LT_SMOKE=1` e a porta 8081 livre — o teste
 * sobe o servidor do Homebrew (`SIMPLEMD_LT_SERVER`, padrão abaixo), derruba no meio da sessão e
 * sobe de novo. O transporte daqui imita o nativo (mesmos códigos de erro), por `fetch` do Node:
 * o app real usa o Rust (variante N).
 *
 * Relógio real de propósito: o critério mede tempos de um processo de verdade (≤ 3 s ao parar o
 * servidor); um relógio falso não prova nada aqui. As esperas são por condição (`until`).
 */
const SERVER_BIN =
  process.env.SIMPLEMD_LT_SERVER ?? '/opt/homebrew/opt/languagetool/bin/languagetool-server';
const SERVER_CONFIG = '/opt/homebrew/etc/languagetool/server.properties';
const BASE = 'http://127.0.0.1:8081/v2';

/** Transporte HTTP de teste com os códigos do Rust (`CONNECTION_REFUSED`, `TIMEOUT`, …). */
function nodeTransport(): LanguageToolTransport {
  let current: { id: number; abort: AbortController } | null = null;
  async function call(path: string, init: RequestInit, ms: number, abort = new AbortController()) {
    const timer = setTimeout(() => abort.abort('timeout'), ms);
    try {
      const response = await fetch(`${BASE}${path}`, { ...init, signal: abort.signal });
      const body = await response.text();
      if (response.status !== 200)
        throw { code: 'LT_HTTP_STATUS', message: 'http', detail: { status: response.status } };
      return body;
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error) throw error;
      if (abort.signal.aborted)
        throw abort.signal.reason === 'timeout'
          ? { code: 'TIMEOUT', message: 't', detail: { seconds: ms / 1000 } }
          : { code: 'CANCELLED', message: 'c' };
      throw { code: 'CONNECTION_REFUSED', message: 'recusado' };
    } finally {
      clearTimeout(timer);
    }
  }
  return {
    languages: () => call('/languages', {}, 2_000),
    async check(request: LtCheckRequest, id: number) {
      current?.abort.abort('cancel');
      const abort = new AbortController();
      current = { id, abort };
      const form = new URLSearchParams({ language: request.language });
      if (request.preferredVariants)
        form.set('preferredVariants', request.preferredVariants.join(','));
      form.set('data', JSON.stringify({ annotation: request.annotation }));
      if (request.disabledRules?.length) form.set('disabledRules', request.disabledRules.join(','));
      return call('/check', { method: 'POST', body: form }, 15_000, abort);
    },
    async cancel(id: number) {
      if (current?.id === id) current.abort.abort('cancel');
    },
  };
}

const realClock = {
  now: () => Date.now(),
  setTimeout: (callback: () => void, ms: number) => setTimeout(callback, ms),
  clearTimeout: (handle: unknown) => clearTimeout(handle as number),
};

let server: ChildProcess | null = null;

async function startServer(): Promise<number> {
  const started = Date.now();
  server = spawn(SERVER_BIN, ['--config', SERVER_CONFIG, '--port', '8081'], { stdio: 'ignore' });
  for (;;) {
    try {
      if ((await fetch(`${BASE}/languages`)).ok) return Date.now() - started;
    } catch {
      // ainda subindo
    }
    if (Date.now() - started > 60_000) throw new Error('LanguageTool não subiu em 60 s');
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function stopServer(): Promise<void> {
  const proc = server;
  server = null;
  if (!proc || proc.exitCode !== null) return;
  const exited = new Promise((resolve) => proc.once('exit', resolve));
  proc.kill('SIGTERM');
  await exited;
}

async function until(check: () => boolean, ms: number, what: string): Promise<number> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > ms) throw new Error(`tempo esgotado: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return Date.now() - started;
}

afterAll(async () => {
  destroyViews();
  await stopServer();
});

describe.skipIf(process.env.SIMPLEMD_LT_SMOKE !== '1')('LanguageTool real (AC-I8.12 sem GUI)', () => {
  test(
    'concordância, "exceção", servidor parado ≤ 3 s, volta com "Tentar de novo"',
    async () => {
      const bootMs = await startServer();
      const doc = 'Eu vai para casa amanhã.\n\nIsso é uma excessão.\n';
      const m = mountLt(doc, { real: { transport: nodeTransport(), clock: realClock } });
      await until(() => m.status()?.state === 'issues', 30_000, 'primeira verificação').catch(
        (error: Error) => {
          throw new Error(`${error.message}: ${JSON.stringify(m.statuses)}`);
        },
      );
      const diags = m.view.state.field(ltField).diags;
      const agreement = diags.find((d) => d.expected === 'Eu vai');
      const spelling = diags.find((d) => d.expected === 'excessão');
      expect(agreement?.match.categoryId).toBe('GRAMMAR');
      expect(spelling?.match.replacements[0]).toBe('exceção');
      const count = diags.length;

      await stopServer();
      m.view.dispatch({ changes: { from: 0, insert: 'Hoje ' } });
      const typedAt = Date.now();
      const downMs = await until(() => m.status()?.state === 'not-found', 3_000 + 1_000, 'não encontrado');
      // ≤ 3 s depois da espera de 1 s da digitação (a verificação só sai 1 s depois da última tecla).
      expect(Date.now() - typedAt - 1_000).toBeLessThanOrEqual(3_000);

      await startServer();
      m.menu('retry');
      const backMs = await until(() => m.status()?.state === 'issues', 20_000, 'voltou');
      const status = m.status();
      expect(status?.state === 'issues' && status.count).toBeGreaterThan(0);
      console.info(
        JSON.stringify({ bootMs, firstCount: count, downMs, backMs, finalStatus: m.status() }),
      );
      m.dispose();
    },
    180_000,
  );
});
