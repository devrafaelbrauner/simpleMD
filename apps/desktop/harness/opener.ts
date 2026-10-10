import type { AppPlatform } from '../src/platform/types';

/**
 * "Abrir URL" falso do harness (r7 arch-backend §1.2; AC-I1.3/I1.4 na QA): registra cada pedido
 * em `calls()` e nunca abre nada. A validação TS é INJETADA (D-R7-SN-01): o espelho das regras do
 * Rust mora no serviço de links (`packages/core/src/links/`, S1), que o registra aqui; sem ele, o
 * falso só registra. `fail` simula uma recusa do Rust (`RATE_LIMITED`, `OPEN_FAILED`…). Só neste
 * bundle (`assert-no-harness` procura o marcador).
 */
export const FAKE_OPENER_MARKER = 'simplemd:fake-opener';

export interface HarnessOpenerCall {
  readonly url: string;
  readonly ts: number;
  /** `true` = chegaria ao SO; `false` = recusada (pela validação injetada ou por `fail`). */
  readonly accepted: boolean;
  readonly code: string | null;
}

/** Validação do espelho TS: o código de recusa, ou `null` para aceitar. */
export type UrlValidator = (url: string) => string | null;

export interface HarnessOpenerControl {
  readonly marker: string;
  /** Recusa forçada (como o Rust devolveria); `null` = aceitar o que passar pela validação. */
  fail: string | null;
  calls(): readonly HarnessOpenerCall[];
  /** Só as aceitas (as que o app teria entregado ao SO). */
  accepted(): readonly HarnessOpenerCall[];
  reset(): void;
}

export function createHarnessOpener(
  options: { validate?: UrlValidator; now?: () => number } = {},
): { openUrl: AppPlatform['openUrl']; control: HarnessOpenerControl } {
  const now = options.now ?? Date.now;
  let calls: HarnessOpenerCall[] = [];
  const control: HarnessOpenerControl = {
    marker: FAKE_OPENER_MARKER,
    fail: null,
    calls: () => calls,
    accepted: () => calls.filter((call) => call.accepted),
    reset() {
      calls = [];
      control.fail = null;
    },
  };
  async function openUrl(url: string): Promise<void> {
    const code = options.validate?.(url) ?? control.fail;
    calls.push({ url, ts: now(), accepted: code === null, code });
    if (code !== null) throw { code, message: `Recusado pelo harness (${code}).` };
  }
  return { openUrl, control };
}
