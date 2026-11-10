import type {
  SpellCoverageSlot,
  SpellReloadScope,
  SpellReloaded,
  SpellTransport,
} from '@simplemd/plugin-api/internal/spell';

/** Língua de uma nota sem `lang:` no front matter (D-R35-3: sem opção de idioma, como o LT). */
export const DEFAULT_SPELL_LANGUAGE = 'pt-BR';

/**
 * Novas tentativas de uma recarga cancelada por fora do app (contrato da r34: repetir no
 * `CANCELLED`): um plugin aprovado chamou `spell_reload`, ou uma recarga dele que falhou logo
 * (`NO_VAULT`/`VAULT_CLOSED`) já tinha vencido a do app sem trocar nada.
 */
export const SPELL_RELOAD_RETRIES = 2;

/**
 * A língua de `langs` (as do motor) que cobre o `lang:` de uma nota: `fmLang` já normalizado
 * (`frontMatterLang`), `null` = sem `lang` → `pt-BR` (D-R35-3). Vale a igual, sem diferença de caixa;
 * para um primário sozinho (`pt`), a única de `langs` com ele; senão `null` (`pt-PT`, `en-US`, `en`,
 * ou `pt` com duas línguas `pt-*` cobertas).
 */
export function coveredLanguage(langs: readonly string[], fmLang: string | null): string | null {
  const wanted = (fmLang ?? DEFAULT_SPELL_LANGUAGE).toLowerCase();
  const exact = langs.find((lang) => lang.toLowerCase() === wanted);
  if (exact !== undefined) return exact;
  if (wanted === '' || wanted.includes('-')) return null;
  const same = langs.filter((lang) => lang.toLowerCase().split('-')[0] === wanted);
  return same.length === 1 ? (same[0] ?? null) : null;
}

/**
 * O corretor offline visto pelo app (r35a; design-r35 §1, D-R35-1), em
 * `InternalAppServices.spellCoverage`:
 * - a cobertura de línguas, escrita só pelo registro do `simplemd.spell` (`set` com as línguas da
 *   recarga dele, `clear` ao desligar ou quando ela falha) e lida pelo do LanguageTool
 *   (`languageFor`, `subscribe`), que deixa a ortografia para o corretor onde ele cobre;
 * - o caminho único do app para `spell_reload` (`reload`), que o controlador chama ao abrir uma
 *   pasta com o corretor ligado (`folder`) e, só se a camada de uma pasta pode estar no motor, ao
 *   abrir uma pasta com ele desligado ou voltar às boas-vindas (`global`): o motor nunca fica com
 *   os termos e os pares de uma pasta que saiu.
 */
export class SpellCoverageService implements SpellCoverageSlot {
  readonly #transport: SpellTransport;
  readonly #listeners = new Set<() => void>();
  #langs: readonly string[] = [];
  /** Sobe a cada `reload`: a recarga vencida por uma mais nova do app não tenta de novo. */
  #generation = 0;
  /** A recarga mais nova do app, com as tentativas dela. */
  #latest: Promise<SpellReloaded> | null = null;

  constructor(transport: SpellTransport) {
    this.#transport = transport;
  }

  languageFor(fmLang: string | null): string | null {
    return coveredLanguage(this.#langs, fmLang);
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  set(langs: readonly string[]): void {
    const next = [...new Set(langs)];
    const same = next.length === this.#langs.length && next.every((l, i) => l === this.#langs[i]);
    if (same) return;
    this.#langs = next;
    for (const listener of [...this.#listeners]) listener();
  }

  clear(): void {
    this.set([]);
  }

  /**
   * `spell_reload` pelo app (contrato da r34): relê as camadas do usuário de `scope` — `folder`, a
   * global e a da pasta ativa da porta (com o token dela); `global`, só a global (sem token). A
   * recarga mais nova do app vence, e a vencida resolve com o resultado dela, sem tentar de novo. Um
   * `CANCELLED` sem recarga mais nova do app veio de fora: repete até `SPELL_RELOAD_RETRIES` vezes,
   * com o mesmo `scope` e o token da hora. Outro erro rejeita com o `SpellError` da porta. O pedido
   * sai na hora (antes do primeiro `await`); a cobertura não muda.
   */
  reload(scope: SpellReloadScope): Promise<SpellReloaded> {
    const generation = ++this.#generation;
    const attempt = this.#attempt(generation, scope);
    this.#latest = attempt;
    return attempt;
  }

  async #attempt(generation: number, scope: SpellReloadScope): Promise<SpellReloaded> {
    for (let retry = 0; ; retry++) {
      try {
        return await this.#transport.reload(scope);
      } catch (error) {
        const cancelled =
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          error.code === 'CANCELLED';
        if (!cancelled) throw error;
        const latest = this.#latest;
        if (generation !== this.#generation && latest !== null) return latest;
        if (retry >= SPELL_RELOAD_RETRIES) throw error;
      }
    }
  }
}
