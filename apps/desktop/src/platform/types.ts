import type { AiTransport } from '@simplemd/ai';
import type { LanguageToolTransport } from '@simplemd/plugin-api/internal/languagetool';
import type { ApprovalsPort } from '@simplemd/plugin-api/runtime';
import type { ContentVaultProvider } from '@simplemd/vault';

export type {
  LanguageToolTransport,
  LtCheckRequest,
  LtSegment,
} from '@simplemd/plugin-api/internal/languagetool';

export type AppLogEvent =
  | 'simplemd:ready'
  | 'simplemd:conflict-shown'
  | 'simplemd:plugin-active'
  | 'simplemd:catalog-shown'
  | 'ai:first-paint'
  | 'simplemd:export-print';

/** Extensões do diálogo de salvar (o Rust põe o filtro e o título). */
export type SaveExt = 'json' | 'md' | 'html';

/** Destino escolhido no diálogo de salvar: um token de uso único, nunca o caminho absoluto. */
export interface SaveTarget {
  readonly token: string;
  readonly fileName: string;
}

/**
 * Salvar em duas etapas (arch-backend r2 §1.2, R-10.3): `pick` abre o diálogo nativo e, com
 * `sourceRel`, recusa o próprio arquivo de origem com o erro `{ code: 'SAME_AS_SOURCE' }` antes de
 * qualquer gravação; `null` = cancelado. `write` grava os bytes no destino do token (uso único).
 */
export interface SaveTargetPort {
  pick(opts: {
    readonly suggestedName: string;
    readonly ext: SaveExt;
    readonly sourceRel?: string;
  }): Promise<SaveTarget | null>;
  write(token: string, bytes: Uint8Array): Promise<void>;
}

/** Provedores com chave no keychain (o Ollama não usa chave). */
export type KeyedProvider = 'openai' | 'anthropic';

/**
 * IA na plataforma (arch-frontend r2 §11.1, §15): o transporte (Tauri: `ai_send`/`ai_cancel`;
 * harness: replay) e as chaves no keychain. **Não há leitura de chave**: só gravar, saber se existe
 * e apagar (R-11.4, AC-11.5). Erros chegam como `{ code, message }` do Rust.
 */
export interface AiPlatform {
  readonly transport: AiTransport;
  setKey(provider: KeyedProvider, value: string): Promise<void>;
  hasKey(provider: KeyedProvider): Promise<boolean>;
  deleteKey(provider: KeyedProvider): Promise<void>;
}

/**
 * Arquivo escolhido para importar: o tamanho vem antes da leitura (teto de 256 KB; NFR-15). No
 * Tauri, acima do teto o Rust não lê nada e `read` rejeita.
 */
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
  readonly vault: ContentVaultProvider;
  /**
   * Registra quem decide o fechamento da janela: `true` deixa fechar; `false` mantém a janela aberta
   * (flush falhou ou há conflito). Devolve a função que cancela o registro.
   */
  onCloseRequested(handler: () => Promise<boolean>): () => void;
  /** Fecha SEM passar pelo flush ("Fechar sem salvar", L4). */
  closeWindow(): Promise<void>;
  /**
   * Linhas de log das NFRs (`simplemd:ready` NFR-7, `simplemd:conflict-shown` NFR-12,
   * `simplemd:plugin-active` NFR-19, `simplemd:catalog-shown` NFR-26, `ai:first-paint` NFR-33e,
   * `simplemd:export-print` NFR-32 = pedido do painel de impressão).
   */
  log(event: AppLogEvent): void;
  /** Diálogo de salvar em duas etapas (exportação, etapa 10). */
  readonly saveTarget: SaveTargetPort;
  /**
   * Abre o painel de impressão do sistema pelo WebView (R-10.5, Q-14): no macOS `window.print()` do
   * Tauri → `plugin:webview|print` (folha na janela, sem retorno de conclusão); no Windows a
   * impressão nativa do WebView2. Rejeita se o painel não abre.
   */
  print(): Promise<void>;
  /**
   * Aprovações de plugins por dispositivo, fora do vault, da pasta ATIVA (D-10). Tauri: comandos
   * `plugin_*` (o Rust usa a raiz que guarda); harness/testes: armazém em memória.
   */
  readonly approvals: ApprovalsPort & { clear(id: string): Promise<void> };
  /** IA: transporte nativo e chaves no keychain (etapa 11). */
  readonly ai: AiPlatform;
  /**
   * "Exportar tema…" (R-5.5): `saveTarget.pick` + `saveTarget.write` num passo só (o tema não tem
   * arquivo de origem a recusar). Devolve o nome do arquivo escolhido (no Tauri o webview nunca vê
   * o caminho absoluto; no harness, o nome do download); `null` = cancelado. Lança se gravar falhar.
   */
  saveFile(suggestedName: string, bytes: Uint8Array): Promise<string | null>;
  /**
   * "Importar tema…" pelo diálogo nativo de abrir (Tauri); `null` = cancelado. Sem ele (harness),
   * a UI usa um `<input type="file">` (`set-import-input`).
   */
  pickFile?: () => Promise<PickedFile | null>;
  /**
   * Abre `http`/`https`/`mailto` no navegador ou no cliente de e-mail do sistema (r7 R-X7.6). O
   * Rust valida (esquemas, credenciais, controle/bidi, tamanho, chaves do `mailto`, 5 aberturas por
   * 10 s) e rejeita com `{ code, message }`: `URL_INVALID` | `URL_SCHEME_NOT_ALLOWED` |
   * `URL_CREDENTIALS` | `URL_CONTROL_CHAR` | `URL_TOO_LONG` | `URL_MAILTO_PARAM` | `RATE_LIMITED` |
   * `OPEN_FAILED`.
   */
  openUrl(url: string): Promise<void>;
  /** LanguageTool local pelo transporte nativo (r7 R-I8.2, variante N). */
  readonly languageTool: LanguageToolTransport;
}
