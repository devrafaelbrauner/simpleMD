/**
 * Corretor ortográfico offline para o plugin interno `simplemd.spell` (r35a; design-r35 §1,
 * D-R35-1). Só tipos, fora da API pública de plugins (`src/types.ts` congelado): o transporte e a
 * cobertura chegam ao registro do plugin por `InternalAppServices` (DA-R7-26), e o `AppPlatform` do
 * desktop reexporta.
 *
 * O motor é o da r34, no Rust (`spell_check`, `spell_suggest`, `spell_reload`): o pt_BR do VERO
 * embutido mais as camadas do usuário (os `.txt` da camada global e da pasta e os pares Hunspell
 * importados), sem rede. Vão ao Rust só a língua, as palavras e o token da pasta aberta; nenhum
 * caminho entra ou sai. Erros chegam como `SpellError`, com o `code` do Rust (fora da lista → `IO`)
 * e uma mensagem do app: quem usa decide pelo `code` e nunca mostra a mensagem do Rust (o `TIMEOUT`
 * dele reusa a do LanguageTool, D-R34-9).
 */

/**
 * Códigos de erro do corretor: `UNSUPPORTED_LANG` (só `pt-BR`), `TOO_MANY_WORDS` (mais de 20.000
 * palavras num `check`; `detail.max`), `CANCELLED` (um pedido mais novo do mesmo comando venceu, de
 * qualquer origem: o app ou um plugin aprovado), `TIMEOUT` (`detail.seconds`; tente depois — o par
 * Hunspell que segurava a consulta fica desligado até o próximo `spell_reload`, e com a fila de um
 * ocupada o pedido sai na hora), `SPELL_UNAVAILABLE` (o dicionário embutido não carregou),
 * `NO_VAULT`/`VAULT_CLOSED` (`reload` com a pasta trocada) e `IO` (pânico numa consulta ou rejeição
 * sem código).
 */
export type SpellErrorCode =
  | 'UNSUPPORTED_LANG'
  | 'TOO_MANY_WORDS'
  | 'CANCELLED'
  | 'TIMEOUT'
  | 'SPELL_UNAVAILABLE'
  | 'NO_VAULT'
  | 'VAULT_CLOSED'
  | 'IO';

export interface SpellError {
  readonly code: SpellErrorCode;
  /** pt-BR, do app (nunca a do Rust). */
  readonly message: string;
  /** `max` em `TOO_MANY_WORDS`; `seconds` em `TIMEOUT`. */
  readonly detail?: { readonly max?: number; readonly seconds?: number };
}

/**
 * Resposta de `spell_reload`: as línguas do motor (`["pt-BR"]`), os termos do usuário (sem
 * repetidos), os pares Hunspell carregados e as fontes deixadas de fora. Nenhum nome nem caminho.
 */
export interface SpellReloaded {
  readonly langs: readonly string[];
  readonly words: number;
  readonly pairs: number;
  readonly skipped: number;
}

export interface SpellTransport {
  /**
   * `spell_check`: os índices, crescentes, das palavras de `words` que nem a base nem as camadas do
   * usuário conhecem. Só `pt-BR`; até 20.000 palavras. O pedido mais novo vence (o anterior →
   * `CANCELLED`) e `[]` só cancela (devolve `[]`); um pedido recusado pela língua ou pelo teto não
   * cancela o anterior. A palavra vai a NFC no Rust; vazia, com espaço, controle ou invisível, com
   * `#` no início ou com mais de 64 caracteres nunca é marcada.
   */
  check(lang: string, words: readonly string[]): Promise<readonly number[]>;
  /**
   * `spell_suggest`: até 5 sugestões para `word` (palavra fora da regra acima → `[]`). Uma por vez:
   * a mais nova vence (`CANCELLED`). Só texto — mostrar por `textContent` e inserir literal, nunca
   * como Markdown ou HTML.
   */
  suggest(lang: string, word: string): Promise<readonly string[]>;
  /**
   * `spell_reload`: relê as camadas do usuário — a global e, com uma pasta aberta, a dela (o token
   * vai só com pasta; o primeiro uso do token de uma pasta pendente a ativa). Sem recarga o motor
   * fica com as camadas anteriores (as da pasta que saiu, inclusive). A recarga mais nova vence
   * (`CANCELLED`), também uma que falhe logo (`NO_VAULT`/`VAULT_CLOSED`) sem trocar nada.
   */
  reload(): Promise<SpellReloaded>;
}

/** Línguas cobertas pelo corretor offline, como o LanguageTool as lê (r35b). */
export interface SpellCoverage {
  /**
   * A língua do motor para o `lang:` do front matter já normalizado (`null` = sem `lang` → `pt-BR`,
   * D-R35-3): a igual (sem diferença de caixa) ou, para um primário sozinho (`pt`), a única coberta
   * com ele; senão `null` — também sem cobertura (plugin desligado ou recarga que falhou).
   */
  languageFor(fmLang: string | null): string | null;
  /** Avisa a cada mudança da cobertura. */
  subscribe(listener: () => void): () => void;
}

/** A cobertura com escrita: só o registro do `simplemd.spell` escreve (D-R35-1). */
export interface SpellCoverageSlot extends SpellCoverage {
  /** As línguas do motor (`SpellReloaded.langs`), com o plugin ligado e a recarga feita. */
  set(langs: readonly string[]): void;
  /** Sem cobertura: plugin desligado ou recarga que falhou. */
  clear(): void;
}
