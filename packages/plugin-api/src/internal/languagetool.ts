/**
 * Transporte do LanguageTool local para o plugin interno `simplemd.languagetool` (r7 arch-backend
 * §1.4; R-I8.2, variante N). Só tipos, fora da API pública de plugins (`src/types.ts` congelado):
 * o plugin importa daqui sem depender de `apps/`, e o `AppPlatform` do desktop reexporta.
 *
 * O HTTP é feito no Rust (`lt_languages`, `lt_check`, `lt_cancel`), só com `127.0.0.1:8081` e
 * `[::1]:8081`, sem proxy nem redirecionamento: não há host, porta ou caminho no pedido. Erros
 * chegam como `{ code, message, detail? }` — `CONNECTION_REFUSED`, `NETWORK`, `TIMEOUT`
 * (`detail.seconds`), `LT_HTTP_STATUS` (`detail.status`), `RESPONSE_TOO_LARGE`, `BAD_UTF8`,
 * `REDIRECT_NOT_FOLLOWED`, `LT_INVALID_REQUEST`, `BODY_TOO_LARGE`, `CANCELLED` — e o plugin mapeia
 * pelo `code` (nunca mostra a mensagem do Rust). `requestId` é inteiro em `[0, 2³²)`; fora disso a
 * plataforma rejeita com `LT_INVALID_REQUEST`. Uma rejeição sem `code` é falha do app (F-08).
 */

/** Um pedaço de `data.annotation`: texto verificado OU marcação ignorada (offsets preservados). */
export type LtSegment =
  { readonly text: string } | { readonly markup: string; readonly interpretAs?: string };

/**
 * Pedido de `POST /v2/check`. O Rust valida (≤ 20.000 unidades UTF-16, ids de regra, línguas) e
 * monta o corpo de formulário; campo a mais → `LT_INVALID_REQUEST`.
 */
export interface LtCheckRequest {
  readonly language: string;
  /** Só com `language = "auto"`. */
  readonly preferredVariants?: readonly string[];
  readonly annotation: readonly LtSegment[];
  readonly disabledRules?: readonly string[];
  readonly disabledCategories?: readonly string[];
}

export interface LanguageToolTransport {
  /** `GET /v2/languages` (2 s): corpo JSON cru (≤ 256 KiB) — o plugin valida e usa `longCode`. */
  languages(): Promise<string>;
  /** `POST /v2/check` (15 s): corpo JSON cru (≤ 2 MiB). Um novo `check` cancela o anterior. */
  check(req: LtCheckRequest, requestId: number): Promise<string>;
  /** Aborta o `check` em voo se o id for o dele; senão nada. */
  cancel(requestId: number): Promise<void>;
}
