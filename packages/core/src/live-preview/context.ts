// Portado de retronav/ixora@1734bce24307fd80c4ea538257efb6f612dc9715 (Apache-2.0), © Pranav Karawale. Modificado para o simpleMD.
// Origem: packages/ixora/src/util.ts (`checkRangeOverlap`, `isCursorInRange`,
// `iterateTreeInVisibleRanges`, `invisibleDecoration`). Mudanças: um contexto por passada, com
// guarda "uma vez por nó" e por linha, a revelação só com o editor focado (F-2) e o despacho
// nome → contribuidores da passada única (arch-frontend r7 §5.1, D-R7-F11).
import { StateEffect, type EditorState, type Range, type Text } from '@codemirror/state';
import { Decoration } from '@codemirror/view';
import type { SyntaxNode } from '@lezer/common';
import { noteContext } from '../assembly/note-context';
import { isTouched } from './focus';
import type { LinkReferences } from './references';

export interface VisibleRange {
  from: number;
  to: number;
}

/** Esconde qualquer trecho (marcas de sintaxe). Constante do módulo: nenhuma alocação por passada. */
export const hide = Decoration.replace({});

/**
 * Pede ao driver em linha que refaça as decorações do viewport sem mudança de texto: um serviço
 * externo mudou o que decide a aparência (ex.: o conjunto de notas de wikilink existente; S2).
 */
export const redecorate = StateEffect.define<null>();

/** Famílias de decoração de linha: uma de cada por linha (`block` = fundo de bloco). */
type LineFamily = 'block' | 'quote';

/**
 * Estado de UMA passada de decorações em linha sobre as faixas visíveis. Os contribuidores leem o
 * documento e acrescentam em `out`; nenhum deles altera o texto (R-I1.8).
 */
export class DecorationContext {
  readonly doc: Text;
  readonly out: Range<Decoration>[] = [];
  /** Faixa visível em percurso (`blockLines` recorta por ela). */
  range: VisibleRange = { from: 0, to: 0 };
  readonly #seen = new Set<string>();
  readonly #lines: Record<LineFamily, Set<number>> = { block: new Set(), quote: new Set() };
  #notePath: string | null | undefined;

  constructor(
    readonly state: EditorState,
    /** Definições `[r]: url` de topo (rótulo normalizado → destino). */
    readonly refs: LinkReferences,
  ) {
    this.doc = state.doc;
  }

  /** Caminho da nota no vault (`noteContext`, ST); `null` sem nota. */
  get notePath(): string | null {
    if (this.#notePath === undefined) this.#notePath = this.state.facet(noteContext).path;
    return this.#notePath;
  }

  /** Um nó que cruza duas faixas visíveis é visitado duas vezes; só decora na primeira. */
  once(node: SyntaxNode): boolean {
    const key = `${node.type.id}@${node.from}`;
    if (this.#seen.has(key)) return false;
    this.#seen.add(key);
    return true;
  }

  /** O editor está focado e a seleção encosta em `[from, to]` (revelação do cru; R-3.2). */
  isTouched(from: number, to: number): boolean {
    return isTouched(this.state, from, to);
  }

  /** Marca a linha que começa em `from` como decorada pela família; `false` se já estava. */
  claimLine(from: number, family: LineFamily = 'block'): boolean {
    const lines = this.#lines[family];
    if (lines.has(from)) return false;
    lines.add(from);
    return true;
  }

  /** Decoração de linha em cada linha do nó que cai na faixa visível atual (uma vez por linha). */
  blockLines(node: SyntaxNode, deco: Decoration): void {
    const start = Math.max(node.from, this.range.from);
    const end = Math.min(node.to, this.range.to);
    if (start > end) return;
    const last = this.doc.lineAt(end).number;
    for (let n = this.doc.lineAt(start).number; n <= last; n++) {
      const from = this.doc.line(n).from;
      if (this.claimLine(from)) this.out.push(deco.range(from));
    }
  }
}

/**
 * Contribuidor em linha (arch-frontend §5.1): os nós Lezer que trata e o que fazer ao entrar.
 * `false` = não descer nos filhos (código, front matter, tabela).
 */
export interface InlineContributor {
  readonly nodes: readonly string[];
  enter(node: SyntaxNode, ctx: DecorationContext): boolean | void;
}
