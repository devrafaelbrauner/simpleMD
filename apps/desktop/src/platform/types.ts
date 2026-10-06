import type { VaultProvider } from '@simplemd/vault';

export type AppLogEvent = 'simplemd:ready' | 'simplemd:conflict-shown';

/** Arquivo escolhido para importar: o tamanho vem antes da leitura (teto de 256 KB; NFR-15). */
export interface PickedFile {
  readonly name: string;
  readonly size: number;
  read(): Promise<Uint8Array>;
}

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
  /**
   * "Exportar tema…" (R-5.5): diálogo de salvar e gravação dos bytes no caminho escolhido. Devolve o
   * caminho (ou o nome do download, no harness); `null` = cancelado. Lança se a gravação falhar.
   */
  saveFile(suggestedName: string, bytes: Uint8Array): Promise<string | null>;
  /**
   * "Importar tema…" pelo diálogo nativo de abrir (Tauri); `null` = cancelado. Sem ele (harness),
   * a UI usa um `<input type="file">` (`set-import-input`).
   */
  pickFile?: () => Promise<PickedFile | null>;
}
