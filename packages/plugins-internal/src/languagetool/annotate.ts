import type { EditorState } from '@codemirror/state';
import type { LtSegment } from '@simplemd/plugin-api/internal/languagetool';
import { unitSegments, unitsIn, type Unit } from '../shared/prose';

/**
 * Do documento para o `data.annotation` do LanguageTool (R-I8.3, AC-I8.3; JEV D-R7-S8-01 A). As
 * unidades de verificação e os trechos `markup` de cada uma vêm de `shared/prose.ts`, comuns ao
 * corretor offline (r35b).
 *
 * Um pedido cobre UM intervalo contíguo do documento; dentro dele, o que não é texto verificável
 * vai como `markup` literal (deslocamentos preservados: posição no documento = início do intervalo
 * + `offset` da resposta, conferido no LT 6.8 real): front matter, código, matemática, URLs,
 * destinos de links/wikilinks, HTML, marcas de ênfase/lista/citação/tabela e os blocos entre
 * unidades (com `interpretAs: "\n\n"`, a quebra de parágrafo que o LT entende).
 */

/** Teto de unidades UTF-16 por pedido (texto + markup), o mesmo do Rust (`policy::MAX_UNITS`). */
export const MAX_REQUEST_UNITS = 20_000;

/** Um pedido pronto: intervalo do documento, segmentos e as unidades que ele verifica. */
export interface PlannedRequest {
  readonly from: number;
  readonly to: number;
  readonly units: readonly Unit[];
  readonly annotation: readonly LtSegment[];
}

/**
 * Divide uma unidade maior que o teto por linhas e, se uma linha sozinha passa do teto, por
 * posições (sem partir um par substituto, de preferência num espaço).
 */
export function splitUnit(state: EditorState, unit: Unit, max = MAX_REQUEST_UNITS): Unit[] {
  if (unit.to - unit.from <= max) return [unit];
  const doc = state.doc;
  const out: Unit[] = [];
  let start = unit.from;
  while (unit.to - start > max) {
    let cut = doc.lineAt(start + max).from - 1; // fim da última linha inteira que cabe
    if (cut <= start) {
      cut = start + max;
      const window = doc.sliceString(start, cut);
      const space = window.lastIndexOf(' ');
      if (space > max / 2) cut = start + space + 1;
      const code = doc.sliceString(cut - 1, cut).charCodeAt(0);
      if (code >= 0xd800 && code <= 0xdbff) cut--;
    }
    out.push({ from: start, to: cut });
    start = cut;
    while (start < unit.to && doc.sliceString(start, start + 1) === '\n') start++;
  }
  if (start < unit.to) out.push({ from: start, to: unit.to });
  return out;
}

/**
 * Agrupa as unidades (ordenadas) em pedidos de intervalo contíguo ≤ `max` unidades UTF-16. Entre
 * duas unidades do mesmo pedido, o que houver vai como markup de bloco. O primeiro pedido começa
 * em 0 quando a primeira unidade é a primeira da nota (o front matter vai como markup, AC-I8.3)
 * e isso cabe no teto — conferido só nesse caso, sobre `[0, início)` (≤ `max`), sem percorrer a
 * nota inteira a cada pedido (CR-S8 N8).
 */
export function planRequests(
  state: EditorState,
  units: readonly Unit[],
  max = MAX_REQUEST_UNITS,
): PlannedRequest[] {
  const pieces = units.flatMap((u) => splitUnit(state, u, max));
  const groups: Unit[][] = [];
  for (const piece of pieces) {
    const group = groups[groups.length - 1];
    if (group && piece.to - (group[0] as Unit).from <= max) group.push(piece);
    else groups.push([piece]);
  }
  return groups.map((group) => {
    const head = group[0] as Unit;
    const last = group[group.length - 1] as Unit;
    const fromStart = head.from > 0 && last.to <= max && unitsIn(state, 0, head.from).length === 0;
    const from = fromStart ? 0 : head.from;
    const annotation: LtSegment[] = [];
    let pos = from;
    for (const unit of group) {
      if (unit.from > pos)
        annotation.push({ markup: state.doc.sliceString(pos, unit.from), interpretAs: '\n\n' });
      annotation.push(...unitSegments(state, unit.from, unit.to));
      pos = unit.to;
    }
    return { from, to: last.to, units: group, annotation };
  });
}
