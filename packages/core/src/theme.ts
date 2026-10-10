import { HighlightStyle } from '@codemirror/language';
import { EditorView } from '@codemirror/view';
import { tags } from '@lezer/highlight';

/** Passo de um nível de citação: meia barra + vão (DESIGN §R7.6.1, 10 px com os tokens padrão). */
const QUOTE_STEP = '(var(--dimension-space-1) / 2 + var(--dimension-space-2))';

/**
 * Barras das citações `cm-md-quote-d1…d6` (D-R7-D03; design-ack §5.4 item 1): sombras internas
 * empilhadas, de cima para baixo: barra k (`border`) e, entre barras, o vão (`bg`). Tudo em
 * `calc()` dos tokens de espaço, nunca o valor transcrito.
 */
function quoteDepthRules(): Record<string, Record<string, string>> {
  const rules: Record<string, Record<string, string>> = {};
  for (let depth = 1; depth <= 6; depth++) {
    const layers: string[] = [];
    for (let k = 0; k < depth; k++) {
      layers.push(
        `inset calc(${k} * ${QUOTE_STEP} + var(--dimension-space-1) / 2) 0 0 var(--color-border)`,
      );
      if (k < depth - 1) layers.push(`inset calc(${k + 1} * ${QUOTE_STEP}) 0 0 var(--color-bg)`);
    }
    rules[`.cm-md-quote-d${depth}`] = {
      paddingInlineStart: `calc(${depth} * ${QUOTE_STEP})`,
      boxShadow: layers.join(', '),
    };
  }
  return rules;
}

/**
 * Tema do editor (arch-frontend §2.6; DESIGN §5 e §8.5). Todo valor visual é uma referência
 * `var(--…)` sem literal de fallback: os valores vêm só de `packages/themes/src/tokens.css`
 * (ou do tema aplicado em tempo de execução). Sem destaque de linha ativa e sem transições.
 */
export const markdownEditorTheme = EditorView.theme({
  '&': {
    height: '100%',
    backgroundColor: 'var(--color-bg)',
    color: 'var(--color-fg)',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-content': {
    fontFamily: 'var(--fontFamily-mono)',
    fontSize: 'var(--dimension-font-size)',
    lineHeight: '1.6',
    maxWidth: '80ch',
    marginInline: 'auto',
    padding: 'var(--dimension-space-6) var(--dimension-space-6) 40vh',
    caretColor: 'var(--color-fg)',
  },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--color-fg)' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection':
    { backgroundColor: 'var(--color-selection)' },

  // Live preview (DESIGN §8.5). Tamanhos de título vêm dos tokens (em), H5/H6 ficam em 1em.
  '.cm-md-h1': { fontSize: 'var(--dimension-h1-size)' },
  '.cm-md-h2': { fontSize: 'var(--dimension-h2-size)' },
  '.cm-md-h3': { fontSize: 'var(--dimension-h3-size)' },
  '.cm-md-h4': { fontSize: 'var(--dimension-h4-size)' },
  '.cm-md-h1, .cm-md-h2, .cm-md-h3, .cm-md-h4': { lineHeight: '1.3', paddingTop: '0.4em' },
  '.cm-md-h1, .cm-md-h2, .cm-md-h3, .cm-md-h4, .cm-md-h5, .cm-md-h6, .cm-md-strong': {
    fontWeight: 'var(--fontWeight-bold)',
  },
  '.cm-md-h6, .cm-md-bullet, .cm-md-list-number, .cm-md-fence-dim': {
    color: 'var(--color-muted)',
  },
  '.cm-md-em': { fontStyle: 'italic' },
  '.cm-md-link': {
    color: 'var(--color-accent)',
    textDecoration: 'underline',
    textDecorationThickness: '1px',
    textUnderlineOffset: '0.2em',
    cursor: 'text',
  },
  // I-1 (DESIGN §R7.6.1–§R7.6.3; design-ack §5: só `var(--…)`, o mix de hairline e `calc()`).
  '&.cm-md-mod .cm-md-link': { cursor: 'pointer' },
  '.cm-md-strike': { textDecoration: 'line-through', textDecorationThickness: '1px' },
  // I-2 (DESIGN §R7.6.4): wikilink = look de `.cm-md-link`; inexistente = atenuado + tracejado
  // (a diferença não é só a cor, P33). Seletor com duas classes para vencer a cor de link.
  '.cm-md-link.cm-md-wikilink-missing': {
    color: 'var(--color-muted)',
    textDecorationLine: 'underline',
    textDecorationStyle: 'dashed',
    textDecorationColor: 'var(--color-muted)',
  },
  '.cm-md-code': {
    backgroundColor: 'var(--color-code-bg)',
    color: 'var(--color-fg)',
    fontFamily: 'var(--fontFamily-mono)',
    borderRadius: 'var(--dimension-radius)',
    paddingInline: 'calc(var(--dimension-space-1) / 2)',
    WebkitBoxDecorationBreak: 'clone',
    boxDecorationBreak: 'clone',
  },
  '.cm-md-quote': { color: 'var(--color-muted)' },
  '.cm-md-quote .cm-md-code': { color: 'inherit' },
  ...quoteDepthRules(),
  '.cm-md-task': {
    display: 'inline-block',
    position: 'relative',
    boxSizing: 'border-box',
    width: '1em',
    height: '1em',
    border: '1px solid var(--color-border)',
    borderRadius: 'calc(var(--dimension-radius) / 2)',
    backgroundColor: 'var(--color-bg)',
    verticalAlign: '-0.15em',
    marginInline: '0.15em 0.35em',
    cursor: 'default',
  },
  '.cm-md-task[data-status="x"]': {
    backgroundColor: 'var(--color-accent)',
    borderColor: 'var(--color-accent)',
  },
  '.cm-md-task > svg': {
    position: 'absolute',
    inset: '0',
    margin: 'auto',
    width: '0.8em',
    height: '0.8em',
    fill: 'none',
    stroke: 'var(--color-on-accent)',
    strokeWidth: '2.4',
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
  },
  '.cm-md-task[data-status="/"]': { boxShadow: 'inset 0 calc(-0.5em + 1px) 0 var(--color-accent)' },
  '.cm-md-task-glyph': {
    position: 'absolute',
    inset: '0',
    display: 'grid',
    placeItems: 'center',
    color: 'var(--color-muted)',
    fontWeight: 'var(--fontWeight-bold)',
    lineHeight: '1',
    fontSize: '0.9em',
  },
  '.cm-md-task-done': { color: 'var(--color-muted)' },
  '.cm-md-img': {
    display: 'block',
    margin: 'var(--dimension-space-2) 0',
    fontFamily: 'var(--fontFamily-ui)',
    fontSize: 'var(--dimension-ui-font-size)',
    lineHeight: '1.45',
  },
  '.cm-md-img > img': { display: 'block', maxWidth: '100%', height: 'auto' },
  '.cm-md-img-inline': { display: 'inline', margin: '0' },
  '.cm-md-img-inline > img': { display: 'inline', maxWidth: '100%', verticalAlign: 'text-bottom' },
  '.cm-md-img[data-state="loading"]': {
    minHeight: 'calc(1.6em + var(--dimension-space-2))',
    padding: 'var(--dimension-space-1) var(--dimension-space-2)',
    border: '1px solid color-mix(in srgb, var(--color-border) 45%, var(--color-bg))',
    borderRadius: 'var(--dimension-radius)',
    color: 'var(--color-muted)',
  },
  '.cm-md-img-inline[data-state="loading"]': {
    display: 'inline-block',
    minHeight: '0',
    padding: '0 var(--dimension-space-2)',
  },
  '.cm-md-img[data-state="not-found"], .cm-md-img[data-state="outside"], .cm-md-img[data-state="bad-type"], .cm-md-img[data-state="too-large"]':
    {
      display: 'flex',
      alignItems: 'flex-start',
      gap: 'var(--dimension-space-2)',
      padding: 'var(--dimension-space-2) var(--dimension-space-3)',
      borderInlineStart: 'calc(var(--dimension-space-1) / 2) solid var(--color-danger)',
      color: 'var(--color-fg)',
    },
  '.cm-md-img-glyph': {
    flex: 'none',
    width: '16px',
    height: '16px',
    marginTop: '0.125rem',
    fill: 'none',
    stroke: 'var(--color-danger)',
    strokeWidth: '1.6',
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
  },
  '.cm-md-img-inline[data-state="not-found"], .cm-md-img-inline[data-state="outside"], .cm-md-img-inline[data-state="bad-type"], .cm-md-img-inline[data-state="too-large"]':
    { display: 'inline', padding: '0', borderInlineStart: 'none' },
  '.cm-md-img-inline > .cm-md-img-glyph': {
    display: 'inline-block',
    width: '0.9em',
    height: '0.9em',
    marginTop: '0',
    marginInlineEnd: '0.25em',
    verticalAlign: '-0.1em',
  },
  // W1: dica de destino do link (nível 1; UX-R7-D16).
  '.cm-tooltip.cm-tooltip-hover': {
    backgroundColor: 'var(--color-bg)',
    border: '1px solid color-mix(in srgb, var(--color-border) 45%, var(--color-bg))',
    borderRadius: 'var(--dimension-radius)',
    boxShadow: 'var(--shadow-dialog)',
  },
  '.cm-md-link-tip': {
    padding: 'var(--dimension-space-1) var(--dimension-space-2)',
    maxWidth: 'min(480px, 80vw)',
    fontFamily: 'var(--fontFamily-ui)',
    fontSize: '12px',
    lineHeight: '1.45',
    color: 'var(--color-fg)',
    overflowWrap: 'anywhere',
  },
  '.cm-md-link-tip-dest': { fontFamily: 'var(--fontFamily-mono)' },
  '.cm-md-link-tip-hint': { color: 'var(--color-muted)' },
  // W4 HTML sanitizado (I-10; DESIGN §R7.6.15, DA-R7-18): moldura de W3 sem cabeçalho; `contain` +
  // `overflow` mantêm todo o conteúdo dentro da caixa (AC-I10.3); conteúdo herda a fonte do editor.
  '.cm-md-html-wrap': { padding: 'var(--dimension-space-2) 0' },
  '.cm-md-html': {
    display: 'block',
    boxSizing: 'border-box',
    padding: 'var(--dimension-space-2) var(--dimension-space-3)',
    border: '1px solid color-mix(in srgb, var(--color-border) 45%, var(--color-bg))',
    borderRadius: 'var(--dimension-radius)',
    backgroundColor: 'var(--color-bg)',
    color: 'var(--color-fg)',
    contain: 'content',
    overflow: 'hidden',
    whiteSpace: 'normal',
    overflowWrap: 'anywhere',
  },
  '.cm-md-html > :first-child': { marginTop: '0' },
  '.cm-md-html > :last-child': { marginBottom: '0' },
  '.cm-md-html pre': { whiteSpace: 'pre-wrap' },
  '.cm-md-html img, .cm-md-html table': { maxWidth: '100%' },
  '.cm-md-html summary': { cursor: 'default', color: 'var(--color-fg)' },
  '.cm-md-html summary:focus-visible, .cm-md-html .cm-md-link:focus-visible': {
    outline: 'var(--dimension-focus-ring) solid var(--color-accent)',
    outlineOffset: 'calc(-1 * var(--dimension-focus-ring))',
  },
  // Widget em linha (defesa em profundidade, R-I10.3/CR-S10-03; JEV D-R7-S10-09): `overflow` e
  // `contain` não valem numa caixa em linha comum, então o grupo vira uma caixa atômica que recorta
  // a própria tinta; `bottom` evita a linha de base sintetizada (`overflow`/`contain` a movem).
  '.cm-md-html-inline': {
    display: 'inline-block',
    maxWidth: '100%',
    overflow: 'hidden',
    verticalAlign: 'bottom',
    contain: 'content',
  },
  // `<br>` sozinho (sem tinta): caixa em linha comum, para a quebra valer na linha do editor.
  '.cm-md-html-inline.cm-md-html-break': { display: 'inline', contain: 'none' },
  // STR-178 (D-R7-D11): cromado do widget em fonte de UI, `muted`.
  '.cm-md-html-empty': {
    color: 'var(--color-muted)',
    fontFamily: 'var(--fontFamily-ui)',
    fontSize: 'var(--dimension-ui-font-size)',
  },
  '.cm-md-html [data-smd-alt], .cm-md-html-inline [data-smd-alt]': { color: 'var(--color-muted)' },
  // `<mark>`: preenchimento `hover` + texto `fg`, sem raio (D-R7-D10; nunca `selection`).
  '.cm-md-mark': {
    backgroundColor: 'var(--color-hover)',
    color: 'var(--color-fg)',
    borderRadius: '0',
  },
  // Brand E-1: texto de destaque nunca sobre `hover`; o link dentro de `<mark>` fica `fg` + sublinhado.
  '.cm-md-mark .cm-md-link, .cm-md-mark .cm-md-wikilink': { color: 'var(--color-fg)' },
  // `<kbd>`: chip do r1 (`code-bg`, `fg`, hairline, `radius`) a 0.85em, fonte herdada.
  '.cm-md-kbd': {
    fontFamily: 'inherit',
    fontSize: '0.85em',
    paddingInline: 'var(--dimension-space-1)',
    border: '1px solid color-mix(in srgb, var(--color-border) 45%, var(--color-bg))',
    borderRadius: 'var(--dimension-radius)',
    backgroundColor: 'var(--color-code-bg)',
    color: 'var(--color-fg)',
  },
  '.cm-md-bullet': { display: 'inline-block', width: '1ch' },
  '.cm-md-codeblock, .cm-md-table-src, .cm-md-frontmatter': {
    backgroundColor: 'var(--color-code-bg)',
  },
  // Front matter (DESIGN §8.18 FME-CLASS): texto `fg`, linhas `---`/`...` em `muted`.
  '.cm-md-frontmatter': { color: 'var(--color-fg)' },
  '.cm-md-frontmatter-delim': { color: 'var(--color-muted)' },
  // Espaço vertical como padding do invólucro, não margem (design-ack DV-4).
  '.cm-md-table-wrap': { padding: 'var(--dimension-space-1) 0' },
  '.cm-md-table': { borderCollapse: 'collapse' },
  '.cm-md-table th, .cm-md-table td': {
    padding: 'calc(var(--dimension-space-1) / 2) var(--dimension-space-3)',
    border: '1px solid color-mix(in srgb, var(--color-border) 45%, var(--color-bg))',
  },
  '.cm-md-table th': {
    backgroundColor: 'var(--color-code-bg)',
    fontWeight: 'var(--fontWeight-bold)',
  },
  // Popup de sugestões (DESIGN §8.17; FDV-4/FDV-5): superfície de nível 1, lista sem rolagem
  // (`maxRenderedOptions: 10`), rótulo mono no tamanho fixo da UI, trecho casado em negrito +
  // sublinhado, detalhe `muted` sem itálico, selecionado = `hover` + barra de destaque.
  '.cm-tooltip.cm-tooltip-autocomplete': {
    backgroundColor: 'var(--color-bg)',
    border: '1px solid color-mix(in srgb, var(--color-border) 45%, var(--color-bg))',
    borderRadius: 'var(--dimension-radius)',
    boxShadow: 'var(--shadow-dialog)',
    fontFamily: 'var(--fontFamily-ui)',
    fontSize: 'var(--dimension-ui-font-size)',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul': {
    maxHeight: 'none',
    fontFamily: 'var(--fontFamily-ui)',
    padding: 'var(--dimension-space-1) 0',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li': {
    position: 'relative',
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr) auto',
    columnGap: 'var(--dimension-space-4)',
    padding: 'var(--dimension-space-1) var(--dimension-space-3)',
    color: 'var(--color-fg)',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]': {
    backgroundColor: 'var(--color-hover)',
    color: 'var(--color-fg)',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]::before': {
    content: '""',
    position: 'absolute',
    insetBlock: '0',
    insetInlineStart: '0',
    width: 'calc(var(--dimension-space-1) / 2)',
    backgroundColor: 'var(--color-accent)',
  },
  '.cm-tooltip-autocomplete .cm-completionLabel': {
    fontFamily: 'var(--fontFamily-mono)',
    fontSize: 'var(--dimension-ui-font-size)',
  },
  '.cm-tooltip-autocomplete .cm-completionMatchedText': {
    fontWeight: 'var(--fontWeight-bold)',
    textDecoration: 'underline',
  },
  '.cm-tooltip-autocomplete .cm-completionDetail': {
    marginLeft: '0',
    color: 'var(--color-muted)',
    fontStyle: 'normal',
    textAlign: 'end',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    fontSize: '0.75rem',
  },
});

/** Sintaxe revelada fica atenuada com a cor `muted` (nunca com opacidade). */
export const markdownHighlightStyle = HighlightStyle.define([
  { tag: [tags.processingInstruction, tags.meta, tags.url], color: 'var(--color-muted)' },
]);
