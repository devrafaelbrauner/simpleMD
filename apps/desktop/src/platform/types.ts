import type { VaultProvider } from '@simplemd/vault';

export type AppLogEvent = 'simplemd:ready' | 'simplemd:conflict-shown';

/**
 * Porta de plataforma do app (arch-frontend §7.2). A UI só conhece esta interface: o Tauri a
 * implementa em `platform/tauri`, o harness do Chromium com a porta em memória (R-2.12).
 */
export interface AppPlatform {
  readonly vault: VaultProvider;
  /**
   * Registra quem decide o fechamento da janela: `true` deixa fechar; `false` mantém a janela aberta
   * (flush falhou ou há conflito). Devolve a função que cancela o registro.
   */
  onCloseRequested(handler: () => Promise<boolean>): () => void;
  /** Fecha SEM passar pelo flush ("Fechar sem salvar", L4). */
  closeWindow(): Promise<void>;
  /** Linhas de log das NFRs (`simplemd:ready` NFR-7, `simplemd:conflict-shown` NFR-12). */
  log(event: AppLogEvent): void;
}
