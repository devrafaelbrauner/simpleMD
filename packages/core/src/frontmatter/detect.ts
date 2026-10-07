/**
 * Detecção do front matter YAML (R-9.1; arch-frontend r2 §3.4). Função pura sobre o texto CRU do
 * arquivo (com BOM e CRLF possíveis): o editor usa a mesma regra pelo nó Lezer `FrontMatter`, e o
 * índice do vault (etapa 9) usa esta função direto.
 */
export interface FrontMatterRange {
  /** 0, ou 1 depois de um BOM (`\uFEFF`). */
  readonly from: 0 | 1;
  /** Fim da linha de fechamento, sem a quebra de linha. */
  readonly to: number;
  /** Início do conteúdo YAML (depois da quebra da linha `---`). */
  readonly contentFrom: number;
  /** Início da linha de fechamento. */
  readonly contentTo: number;
  readonly closer: '---' | '...';
  /** Conteúdo acima de 256 KiB: o YAML não é interpretado (o nó existe mesmo assim). */
  readonly tooLarge: boolean;
}

/** A busca pela linha de fechamento para em 1 MiB (então não há front matter). */
export const FRONT_MATTER_SEARCH_LIMIT = 1_048_576;
/** Acima disto o YAML não é interpretado e o painel avisa (NFR-29). */
export const FRONT_MATTER_MAX_CONTENT = 262_144;

const OPENER = /^---[ \t]*$/;
const CLOSER = /^(---|\.\.\.)[ \t]*$/;

/**
 * Front matter = bloco que começa no offset 0 (ou 1, depois de um BOM) com uma linha exatamente
 * `---` (espaços/tabs no fim permitidos) e termina na próxima linha exatamente `---` ou `...`. LF
 * ou CRLF. Sem fechamento (até 1 MiB) → `null`.
 */
export function detectFrontMatter(text: string): FrontMatterRange | null {
  const from = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const firstEnd = text.indexOf('\n', from);
  if (firstEnd === -1) return null;
  if (!OPENER.test(text.slice(from, text[firstEnd - 1] === '\r' ? firstEnd - 1 : firstEnd)))
    return null;
  const contentFrom = firstEnd + 1;
  const limit = Math.min(text.length, from + FRONT_MATTER_SEARCH_LIMIT);
  for (let start = contentFrom; start < limit;) {
    let end = text.indexOf('\n', start);
    if (end === -1) end = text.length;
    const lineEnd = text[end - 1] === '\r' ? end - 1 : end;
    const first = text.charCodeAt(start);
    // Só linhas que começam com '-' ou '.' podem fechar (evita uma fatia por linha).
    const match = first === 45 || first === 46 ? CLOSER.exec(text.slice(start, lineEnd)) : null;
    if (match) {
      return {
        from,
        to: lineEnd,
        contentFrom,
        contentTo: start,
        closer: match[1] as '---' | '...',
        tooLarge: start - contentFrom > FRONT_MATTER_MAX_CONTENT,
      };
    }
    start = end + 1;
  }
  return null;
}
