import { EditorView } from '@codemirror/view';
import { getLatexSuiteConfig } from './cm/config';

/** Textos vinculantes (STR-172, arch-ux §7.2). */
export const LATEX_TEXT = {
  expand: 'Expandir snippet LaTeX',
  nextField: 'LaTeX: Próximo campo do snippet',
  prevField: 'LaTeX: Campo anterior do snippet',
  nothingToExpand: 'Nenhum snippet LaTeX para expandir aqui.',
  fieldsEnded: 'Campos encerrados.',
} as const;

/** Id do elemento que o núcleo liga por `aria-describedby` só com a chave Tab ligada (DA-R7-11). */
const TAB_HELP_ID = 'smd-editor-tab-help';

/**
 * A chave "Tecla Tab no editor" está ligada nesta view: o núcleo põe `aria-describedby` =
 * `smd-editor-tab-help` no conteúdo só dentro do compartimento `#hostKeys` (DA-R7-11; JEV
 * D-R7-S6-03). Só muda a frase da primeira vez; o Tab em si só chega à cadeia com a chave ligada.
 */
export function captureTabOn(view: EditorView): boolean {
  return view.state
    .facet(EditorView.contentAttributes)
    .some((attrs) => typeof attrs === 'object' && attrs['aria-describedby'] === TAB_HELP_ID);
}

/**
 * "Campo <i> de <n>"; na primeira sessão de paradas desde que o plugin ligou, a frase longa com o
 * atalho falado (palavras, não símbolos) — sem "Tab ou" com a chave desligada (arch-ux §7.2).
 */
export function announceStop(view: EditorView, index: number, count: number): void {
  const settings = getLatexSuiteConfig(view.state);
  if (!settings) return;
  const field = `Campo ${index + 1} de ${count}`;
  if (index !== 0 || settings.hint.shown) {
    settings.announce(field);
    return;
  }
  settings.hint.shown = true;
  const key =
    settings.platform === 'mac'
      ? 'Command+Option+Seta para a direita'
      : 'Ctrl+Alt+Seta para a direita';
  const via = captureTabOn(view) ? `Tab ou ${key}` : key;
  settings.announce(`${field}. ${via} vai ao próximo; Esc encerra.`);
}
