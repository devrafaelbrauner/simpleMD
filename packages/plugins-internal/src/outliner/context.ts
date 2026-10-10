import { getIndentUnit, indentString } from '@codemirror/language';
import type { EditorState } from '@codemirror/state';
import type { OperationPerformer } from './model/perform';
import type { Parser } from './model/parser';
import type { OutlinerSettings } from './model/settings';

/** O que as partes do outliner compartilham numa ativação do plugin. */
export interface OutlinerContext {
  readonly settings: OutlinerSettings;
  readonly parser: Parser;
  readonly performer: OperationPerformer;
  readonly platform: 'mac' | 'other';
  /** Anúncio do editor (`host.editor.announce`, arch-ux §7.2). */
  announce(text: string): void;
}

const INDENTED_ITEM = /^([ \t]+)(?:[-*+]|\d+\.)[ \t]/;

/**
 * Unidade de indentação para um item sem irmão/filho de onde copiar (R-I7.5): a do primeiro item
 * indentado do documento (tab, 2 ou 4 espaços, como estiver); sem nenhum, a `indentUnit` do editor.
 * O primeiro item indentado de um documento é de nível 1 (precisa de um pai antes dele).
 */
export function defaultIndentChars(state: EditorState): string {
  for (let n = 1; n <= state.doc.lines; n++) {
    const indent = INDENTED_ITEM.exec(state.doc.line(n).text)?.[1];
    if (indent) return indent.includes('\t') ? '\t' : indent;
  }
  return indentString(state, getIndentUnit(state));
}
