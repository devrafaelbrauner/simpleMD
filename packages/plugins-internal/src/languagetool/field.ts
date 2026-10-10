import { StateEffect, StateField, type ChangeDesc } from '@codemirror/state';
import type { LtMatch } from './response';

/**
 * Diagnósticos do LanguageTool no estado do editor (arch-frontend r7 §10.5 `field.ts`; R-I8.4,
 * AC-I8.5). Cada diagnóstico guarda o texto que o LT viu (`expected`); a cada mudança, o que a
 * mudança toca sai e o resto é mapeado — então o texto sob um sublinhado é sempre o verificado
 * ("nunca um sublinhado fora do lugar"). O parágrafo tocado volta a ser verificado pelo agendador.
 */

export interface LtDiag {
  readonly from: number;
  readonly to: number;
  /** Texto do documento em `[from, to)` quando o LT respondeu. */
  readonly expected: string;
  readonly match: LtMatch;
  readonly spelling: boolean;
}

/** Ocorrência ignorada na sessão ("Ignorar"): mesma regra, mesmo texto, mesmo lugar (mapeado). */
interface Ignored {
  readonly from: number;
  readonly to: number;
  readonly ruleId: string;
  readonly expected: string;
}

export interface LtFieldValue {
  readonly diags: readonly LtDiag[];
  readonly ignored: readonly Ignored[];
}

export interface Range {
  readonly from: number;
  readonly to: number;
}

/** Resultado de um pedido: substitui os diagnósticos dentro de `ranges` pelos novos. */
export const ltResults = StateEffect.define<{ ranges: readonly Range[]; diags: readonly LtDiag[] }>();
/** Remove os diagnósticos que cruzam `ranges` (tempo esgotado: parágrafos alterados). */
export const ltDrop = StateEffect.define<readonly Range[]>();
/** Remove todos (servidor ausente, plugin desligado). */
export const ltClearAll = StateEffect.define<null>();
/** Remove os de uma regra desativada ou de uma palavra do dicionário. */
export const ltRemoveWhere = StateEffect.define<
  { readonly ruleId: string } | { readonly word: string }
>();
/** "Ignorar" esta ocorrência (até o texto dela mudar). */
export const ltIgnore = StateEffect.define<LtDiag>();

/** Mapeia `[from, to)` pelas mudanças; `null` se uma mudança o toca. */
function mapUntouched<T extends Range>(item: T, changes: ChangeDesc): T | null {
  if (changes.touchesRange(item.from, item.to)) return null;
  return { ...item, from: changes.mapPos(item.from), to: changes.mapPos(item.to) };
}

/** O diagnóstico casa com uma ocorrência ignorada. */
export function isIgnored(diag: LtDiag, ignored: readonly Ignored[]): boolean {
  return ignored.some(
    (i) =>
      i.from === diag.from &&
      i.to === diag.to &&
      i.ruleId === diag.match.ruleId &&
      i.expected === diag.expected,
  );
}

export const ltField = StateField.define<LtFieldValue>({
  create: () => ({ diags: [], ignored: [] }),
  update(value, tr) {
    let { diags, ignored } = value;
    if (tr.docChanged) {
      diags = diags.flatMap((d) => mapUntouched(d, tr.changes) ?? []);
      ignored = ignored.flatMap((i) => mapUntouched(i, tr.changes) ?? []);
    }
    for (const effect of tr.effects) {
      if (effect.is(ltResults)) {
        const { ranges, diags: incoming } = effect.value;
        diags = [
          ...diags.filter((d) => !ranges.some((r) => d.from >= r.from && d.to <= r.to)),
          ...incoming.filter((d) => !isIgnored(d, ignored)),
        ].sort((a, b) => a.from - b.from || a.to - b.to);
      } else if (effect.is(ltDrop)) {
        diags = diags.filter((d) => !effect.value.some((r) => d.from < r.to && d.to > r.from));
      } else if (effect.is(ltClearAll)) {
        diags = [];
      } else if (effect.is(ltRemoveWhere)) {
        const what = effect.value;
        diags = diags.filter((d) =>
          'ruleId' in what ? d.match.ruleId !== what.ruleId : !(d.spelling && d.expected === what.word),
        );
      } else if (effect.is(ltIgnore)) {
        const d = effect.value;
        ignored = [...ignored, { from: d.from, to: d.to, ruleId: d.match.ruleId, expected: d.expected }];
        diags = diags.filter((x) => !isIgnored(x, ignored));
      }
    }
    return diags === value.diags && ignored === value.ignored ? value : { diags, ignored };
  },
});
