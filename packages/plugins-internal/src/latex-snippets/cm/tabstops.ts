// Portado de artisticat1/obsidian-latex-suite@5db51cf36abccdbbfa51184bb5fe86be8157cc2f (MIT), © 2022 artisticat1. Modificado para o simpleMD.
// Origem: src/snippets/tabstop.ts, src/snippets/codemirror/tabstops_state_field.ts e
// `SnippetChangeSpec.getTabstops` de src/snippets/codemirror/snippet_change_spec.ts. Mudanças: os
// marcadores `$N`/`${N:texto}` saem do texto ANTES de entrar no documento (uma transação só por
// expansão, JEV D-R7-S6-06); o estado é imutável, com índice da parada ativa (volta com Shift-Tab
// ou `Mod-Alt-←`, R-I6.5); paradas pendentes = `.cm-ltx-stop` e parada vazia = widget
// `.cm-ltx-stop-empty` (DA-R7-19), sem as cores do upstream.
import {
  EditorSelection,
  StateEffect,
  StateField,
  type ChangeDesc,
  type EditorState,
  type Extension,
  type Range,
} from '@codemirror/state';
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view';
import { findMatchingBracket } from '../features/brackets';

export interface StopRange {
  readonly from: number;
  readonly to: number;
}

/** Parada lida da substituição: número e posição relativa ao início do texto inserido. */
export interface TabstopSpec extends StopRange {
  readonly number: number;
}

/** Substituição sem os marcadores e as paradas encontradas (offsets relativos ao texto). */
export interface ParsedReplacement {
  readonly text: string;
  readonly stops: readonly TabstopSpec[];
}

/**
 * Tira os marcadores `$N` (um dígito, como no upstream) e `${N:texto}` da substituição. Um `$`
 * que não é marcador fica como está (ex.: `mk` → `$$0$` insere `$$` com a parada entre eles).
 */
export function parseTabstops(replacement: string): ParsedReplacement {
  let text = '';
  const stops: TabstopSpec[] = [];
  for (let i = 0; i < replacement.length; i++) {
    const ch = replacement.charAt(i);
    if (ch !== '$') {
      text += ch;
      continue;
    }
    const digit = replacement.charAt(i + 1);
    if (digit >= '0' && digit <= '9') {
      stops.push({ number: Number(digit), from: text.length, to: text.length });
      i++;
      continue;
    }
    if (digit === '{') {
      const closing = findMatchingBracket(replacement, i + 1, '{', '}', false);
      const body = closing === -1 ? '' : replacement.slice(i + 2, closing);
      const colon = body.indexOf(':');
      const number =
        colon > 0 && /^\d+$/.test(body.slice(0, colon)) ? Number(body.slice(0, colon)) : NaN;
      if (!Number.isNaN(number)) {
        const placeholder = body.slice(colon + 1);
        stops.push({ number, from: text.length, to: text.length + placeholder.length });
        text += placeholder;
        i = closing;
        continue;
      }
    }
    text += ch;
  }
  return { text, stops };
}

/** Paradas de mesmo número formam um grupo (vários cursores); grupos em ordem crescente. */
export function groupStops(stops: readonly TabstopSpec[]): StopRange[][] {
  const byNumber = new Map<number, StopRange[]>();
  for (const stop of stops) {
    const group = byNumber.get(stop.number) ?? [];
    group.push({ from: stop.from, to: stop.to });
    byNumber.set(stop.number, group);
  }
  return [...byNumber.entries()].sort((a, b) => a[0] - b[0]).map(([, group]) => group);
}

/** Sessão de paradas: os grupos (em ordem) e o índice do grupo ativo (= a seleção do CM). */
export interface StopSession {
  readonly groups: readonly (readonly StopRange[])[];
  readonly active: number;
}

/** Inclusivo: digitar na borda de uma parada a aumenta (a parada vazia vira o texto digitado). */
export function mapSession(session: StopSession, changes: ChangeDesc): StopSession {
  return {
    active: session.active,
    groups: session.groups.map((group) =>
      group.map((range) => ({
        from: changes.mapPos(range.from, -1),
        to: changes.mapPos(range.to, 1),
      })),
    ),
  };
}

/** Começa (ou, no refazer, restaura) uma sessão; o valor já está nas coordenadas da transação. */
export const startStops = StateEffect.define<StopSession>({ map: mapSession });
/** Desfazer de uma expansão: encerra e guarda a sessão para o refazer (cm/history.ts). */
export const undoneStops = StateEffect.define<StopSession>({ map: mapSession });
/** Vai ao grupo de índice `value` (Tab/Shift-Tab, `Mod-Alt-→/←`). */
export const moveStops = StateEffect.define<number>();
/** Encerra a sessão (Esc, fim). */
export const clearStops = StateEffect.define<null>();

/** O grupo contém toda a seleção (cada intervalo dentro de algum intervalo do grupo). */
export function groupContains(group: readonly StopRange[], selection: EditorSelection): boolean {
  return selection.ranges.every((sel) =>
    group.some((range) => range.from <= sel.from && sel.to <= range.to),
  );
}

export function groupSelection(group: readonly StopRange[], endpoints = false): EditorSelection {
  return EditorSelection.create(
    group.map((range) => EditorSelection.range(endpoints ? range.to : range.from, range.to)),
  );
}

/**
 * Estado das paradas. Uma seleção que não veio do próprio plugin reconcilia: dentro do grupo ativo
 * segue; dentro de outro grupo passa a ele; fora de todos encerra (R-I6.5 "sair da região
 * encerra"). Chegar ao último grupo encerra a sessão (como no upstream).
 */
export const tabstopsField = StateField.define<StopSession | null>({
  create: () => null,
  update(value, tr) {
    let session = value && tr.docChanged ? mapSession(value, tr.changes) : value;
    let own = false;
    for (const effect of tr.effects) {
      if (effect.is(startStops)) {
        session = effect.value;
        own = true;
      } else if (effect.is(moveStops) && session) {
        session = { groups: session.groups, active: effect.value };
        own = true;
      } else if (effect.is(clearStops) || effect.is(undoneStops)) {
        session = null;
        own = true;
      }
    }
    if (session && tr.selection && !own) {
      const { groups } = session;
      const current = groups[session.active];
      if (!current || !groupContains(current, tr.selection)) {
        const selection = tr.selection;
        const index = groups.findIndex((group) => groupContains(group, selection));
        session = index === -1 ? null : { groups, active: index };
      }
    }
    if (session && session.active >= session.groups.length - 1) session = null;
    return session;
  },
  provide: (field) => EditorView.decorations.from(field, stopDecorations),
});

/** Parada vazia pendente: um espaço de `0.5ch` com borda pontilhada, sem texto (DA-R7-19). */
class EmptyStopWidget extends WidgetType {
  toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = 'cm-ltx-stop-empty';
    span.setAttribute('aria-hidden', 'true');
    return span;
  }

  override eq(): boolean {
    return true;
  }

  override ignoreEvent(): boolean {
    return false;
  }
}

const STOP_MARK = Decoration.mark({ class: 'cm-ltx-stop', inclusive: true });
const EMPTY_STOP = Decoration.widget({ widget: new EmptyStopWidget(), side: 1 });

/**
 * Marcas das paradas pendentes: nem o grupo ativo (é a seleção do CM) nem o último, a parada final
 * (DESIGN §R7.6.12 "a parada final não tem marca"; no latex-suite `$0` é a PRIMEIRA parada, então
 * a final é o grupo de número mais alto; JEV D-R7-S6-02).
 */
function stopDecorations(session: StopSession | null): DecorationSet {
  if (!session) return Decoration.none;
  const ranges: Range<Decoration>[] = [];
  const last = session.groups.length - 1;
  session.groups.forEach((group, index) => {
    if (index === session.active || index === last) return;
    for (const range of group)
      ranges.push(
        range.from === range.to
          ? EMPTY_STOP.range(range.from)
          : STOP_MARK.range(range.from, range.to),
      );
  });
  return Decoration.set(ranges, true);
}

export function activeSession(state: EditorState): StopSession | null {
  return state.field(tabstopsField, false) ?? null;
}

/** Tema das paradas (só tokens do app; DA-R7-19/DA-R7-29). */
export const tabstopTheme: Extension = EditorView.baseTheme({
  '.cm-ltx-stop': {
    textDecorationLine: 'underline',
    textDecorationStyle: 'dotted',
    textDecorationColor: 'var(--color-muted)',
    textDecorationThickness: '0.12em',
    textUnderlineOffset: '0.2em',
  },
  '.cm-ltx-stop-empty': {
    display: 'inline-block',
    width: '0.5ch',
    height: '1em',
    verticalAlign: '-0.2em',
    borderBottom: '1px dotted var(--color-muted)',
  },
});
