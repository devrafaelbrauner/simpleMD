/**
 * Codec de fim de linha e BOM (arch-backend §1.5.6, R-2.5). O editor só vê texto com `\n` e sem
 * BOM; ao salvar, o estilo original volta. Arquivos puramente LF ou CRLF fazem ida e volta byte a
 * byte. Arquivos mistos são normalizados para o estilo dominante no primeiro salvamento.
 */
export interface TextFormat {
  readonly eol: '\n' | '\r\n';
  readonly bom: boolean;
  /** Mais de um tipo de quebra de linha (CRLF, LF, CR) no arquivo. */
  readonly mixed: boolean;
}

const BOM = '\uFEFF';

function count(text: string, pattern: RegExp): number {
  return text.match(pattern)?.length ?? 0;
}

export function decodeDocument(raw: string): { doc: string; format: TextFormat } {
  const bom = raw.startsWith(BOM);
  const body = bom ? raw.slice(1) : raw;
  const crlf = count(body, /\r\n/g);
  const lf = count(body, /(?<!\r)\n/g);
  const cr = count(body, /\r(?!\n)/g);
  const kinds = [crlf, lf, cr].filter((n) => n > 0).length;
  return {
    doc: body.replace(/\r\n?/g, '\n'),
    format: { eol: crlf > lf + cr ? '\r\n' : '\n', bom, mixed: kinds > 1 },
  };
}

export function encodeDocument(doc: string, format: TextFormat): string {
  const body = format.eol === '\r\n' ? doc.replace(/\n/g, '\r\n') : doc;
  return format.bom ? BOM + body : body;
}
