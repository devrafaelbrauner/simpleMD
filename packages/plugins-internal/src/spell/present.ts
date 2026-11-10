import { forceLinting, linter, type Diagnostic } from '@codemirror/lint';
import {
  EditorSelection,
  StateEffect,
  StateField,
  type ChangeDesc,
  type Extension,
} from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import type { DictionaryLayer } from '@simplemd/plugin-api/internal/host';
import { problemDiagnostic, type ProblemAction } from '../shared/diagnostics-ui';

/**
 * Sublinhados e cartão do corretor offline (design-r35 §1, r35c) pela UI compartilhada de
 * diagnósticos (`shared/diagnostics-ui.ts`, a do lint e do LanguageTool): ondulado `danger`,
 * `source: 'spell'`, `kind: 'spelling'`, título "Ortografia". O cartão traz até 5 "Trocar por “y”"
 * (um passo de desfazer cada), "Ignorar" (a palavra, só nesta sessão) e "Adicionar ao dicionário"
 * (na camada da opção "Adicionar palavras ao"; o sublinhado sai depois de gravado). Sugestões e
 * texto da nota só como texto (`textContent`); a troca insere a sugestão literal.
 *
 * O campo guarda o texto que o motor viu (`expected`): a cada mudança, o que ela toca sai e o resto
 * é mapeado — um sublinhado nunca fica fora do lugar. Publicado por `linter()` sem espera própria,
 * lendo o campo (a verificação é do agendador, `checker.ts`).
 */

export interface Range {
  readonly from: number;
  readonly to: number;
}

export interface SpellDiag {
  readonly from: number;
  readonly to: number;
  /** Texto do documento em `[from, to)` quando a palavra foi marcada. */
  readonly expected: string;
  /** A palavra como foi ao motor (NFC, `’` → `'`): a chave do cache, do "Ignorar" e do dicionário. */
  readonly word: string;
  /** A língua do motor em que ela não existe (`pt-BR`). */
  readonly lang: string;
  /** Até 5 sugestões do motor; `null` enquanto não chegaram. */
  readonly suggestions: readonly string[] | null;
}

/** Resultado de uma verificação: troca os diagnósticos dentro de `ranges` pelos novos. */
export const spellResults = StateEffect.define<{
  readonly ranges: readonly Range[];
  readonly diags: readonly SpellDiag[];
}>();
/** Sugestões que chegaram para `word`: valem para todas as ocorrências marcadas dela. */
export const spellSuggestions = StateEffect.define<{
  readonly word: string;
  readonly suggestions: readonly string[];
}>();
/** Tira os diagnósticos que `drop` aponta (palavra ignorada ou que o dicionário passou a aceitar). */
export const spellRemoveWhere = StateEffect.define<(diag: SpellDiag) => boolean>();
/** Tira todos (a nota saiu da cobertura). */
export const spellClearAll = StateEffect.define<null>();

/** Mapeia `[from, to)` pelas mudanças (o mesmo objeto se não andou); `null` se uma mudança o toca. */
function mapUntouched(diag: SpellDiag, changes: ChangeDesc): SpellDiag | null {
  if (changes.touchesRange(diag.from, diag.to)) return null;
  const from = changes.mapPos(diag.from);
  const to = changes.mapPos(diag.to);
  return from === diag.from && to === diag.to ? diag : { ...diag, from, to };
}

export const spellField = StateField.define<readonly SpellDiag[]>({
  create: () => [],
  update(diags, tr) {
    let next = diags;
    if (tr.docChanged) {
      const mapped = diags.flatMap((d) => mapUntouched(d, tr.changes) ?? []);
      // Nada tocado nem deslocado (a edição veio depois de todos): o campo fica igual, sem repintar.
      if (mapped.length !== diags.length || mapped.some((d, i) => d !== diags[i])) next = mapped;
    }
    for (const effect of tr.effects) {
      if (effect.is(spellResults)) {
        const { ranges, diags: incoming } = effect.value;
        next = [
          ...next.filter((d) => !ranges.some((r) => d.from >= r.from && d.to <= r.to)),
          ...incoming,
        ].sort((a, b) => a.from - b.from || a.to - b.to);
      } else if (effect.is(spellSuggestions)) {
        const { word, suggestions } = effect.value;
        if (next.some((d) => d.word === word && d.suggestions !== suggestions))
          next = next.map((d) => (d.word === word ? { ...d, suggestions } : d));
      } else if (effect.is(spellRemoveWhere)) {
        const kept = next.filter((d) => !effect.value(d));
        if (kept.length !== next.length) next = kept;
      } else if (effect.is(spellClearAll) && next.length > 0) {
        next = [];
      }
    }
    return next;
  },
});

/** "dicionário deste computador" / "dicionário desta pasta" (anúncio, como no LanguageTool). */
export const DICTIONARY_NAMES: Readonly<Record<DictionaryLayer, string>> = {
  global: 'deste computador',
  folder: 'desta pasta',
};

/** Nome da língua na mensagem do cartão (a única do motor hoje é o pt-BR). */
const LANGUAGE_NAMES: Readonly<Record<string, string>> = { 'pt-BR': 'Português do Brasil' };

/** Até onde uma sugestão vira botão: o tamanho de um termo e nada de controle ou invisível. */
export const MAX_SUGGESTIONS = 5;
const MAX_SUGGESTION_CHARS = 64;
/** Controle (inclusive quebras), formatação invisível, separadores de linha/parágrafo e metade de par. */
const NOT_INSERTABLE = /[\p{Cc}\p{Cf}\p{Cs}\u2028\u2029]/u;

/** As sugestões que podem virar "Trocar por": texto não vazio, ≤ 64 caracteres, sem Cc/Cf/quebra. */
export function insertable(suggestions: readonly unknown[]): string[] {
  const out: string[] = [];
  for (const value of suggestions) {
    if (typeof value !== 'string' || value === '' || NOT_INSERTABLE.test(value)) continue;
    if ([...value].length > MAX_SUGGESTION_CHARS || out.includes(value)) continue;
    out.push(value);
    if (out.length === MAX_SUGGESTIONS) break;
  }
  return out;
}

export interface SpellActions {
  /**
   * Grava a palavra no dicionário do usuário, na camada da opção "Adicionar palavras ao". A camada
   * gravada, ou `null` se não coube, não é um termo válido ou a gravação falhou (o aviso é de quem
   * implementa); nunca rejeita.
   */
  addWord(word: string): Promise<DictionaryLayer | null>;
  /** Esconde a palavra em todo lugar nesta sessão (D-R35-2; nunca gravada). */
  ignore(word: string): void;
  /** Tira de todas as notas abertas os sublinhados que o dicionário passou a aceitar. */
  dictionaryChanged(): void;
  announce(text: string): void;
}

/** Diagnóstico do CM de cada `SpellDiag` (o mesmo objeto enquanto o `SpellDiag` não muda). */
const cache = new WeakMap<SpellDiag, Diagnostic>();

function actionsFor(diag: SpellDiag, actions: SpellActions): ProblemAction[] {
  const replace: ProblemAction[] = insertable(diag.suggestions ?? []).map((value) => ({
    action: 'replace',
    label: `Trocar por “${value}”`,
    group: 1,
    run(view, from, to) {
      // Defesa: o texto sob o sublinhado tem de ser o que o motor viu.
      if (view.state.sliceDoc(from, to) !== diag.expected) return;
      view.dispatch({
        changes: { from, to, insert: value },
        selection: EditorSelection.cursor(from + value.length),
        userEvent: 'input.replace',
        scrollIntoView: true,
      });
      actions.announce(`Trocado por “${value}”.`);
    },
  }));
  return [
    ...replace,
    {
      action: 'ignore',
      label: 'Ignorar',
      group: 2,
      run() {
        actions.ignore(diag.word);
        actions.announce(`“${diag.expected}” ignorada nesta sessão.`);
      },
    },
    {
      action: 'dictionary',
      label: 'Adicionar ao dicionário',
      group: 2,
      run() {
        // O sublinhado só sai depois de gravado; falha → continua, com aviso.
        void actions.addWord(diag.word).then((layer) => {
          if (!layer) return;
          actions.dictionaryChanged();
          actions.announce(
            `“${diag.expected}” adicionada ao dicionário ${DICTIONARY_NAMES[layer]}.`,
          );
        });
      },
    },
  ];
}

export function toDiagnostic(diag: SpellDiag, actions: SpellActions): Diagnostic {
  const known = cache.get(diag);
  if (known) return known;
  const made = problemDiagnostic(diag.from, diag.to, {
    source: 'spell',
    kind: 'spelling',
    title: 'Ortografia',
    label: 'Ortografia',
    body: `“${diag.expected}” não está no dicionário (${LANGUAGE_NAMES[diag.lang] ?? diag.lang}).`,
    actions: actionsFor(diag, actions),
  });
  cache.set(diag, made);
  return made;
}

/** Fonte do `@codemirror/lint`: só lê o campo (a verificação é do agendador). */
export function spellLinter(actions: SpellActions): Extension {
  return linter((view) => view.state.field(spellField).map((d) => toDiagnostic(d, actions)), {
    needsRefresh: (update) =>
      update.startState.field(spellField, false) !== update.state.field(spellField, false),
  });
}

/** Pinta já, em vez de esperar a espera do lint (o campo mudou: resultado, sugestão, remoção). */
export function repaint(view: EditorView): void {
  queueMicrotask(() => forceLinting(view));
}
