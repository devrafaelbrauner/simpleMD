import { detectFrontMatter } from '../frontmatter/detect';

const BLANK = /^[ \t]*\r?$/;

/**
 * "Sem front matter" (R-10.2, AC-10.1): tira o bloco do front matter — da linha `---` até a linha de
 * fechamento com a quebra dela — e no máximo UMA linha em branco logo depois; nada mais muda. Sem
 * front matter o texto volta igual. Funciona no texto do editor (só `\n`) e no texto cru (BOM e
 * CRLF ficam como estavam, porque nada fora do bloco é tocado).
 */
export function stripFrontMatter(text: string): string {
  const fm = detectFrontMatter(text);
  if (!fm) return text;
  let end = fm.to;
  if (text.startsWith('\r\n', end)) end += 2;
  else if (text[end] === '\n') end += 1;
  const next = text.indexOf('\n', end);
  const lineEnd = next === -1 ? text.length : next;
  if (lineEnd > end || next !== -1) {
    if (BLANK.test(text.slice(end, lineEnd))) end = next === -1 ? text.length : next + 1;
  }
  return text.slice(0, fm.from) + text.slice(end);
}
