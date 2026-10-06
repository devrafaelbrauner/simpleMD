/**
 * Codec de fim de linha e BOM (arch-backend §1.5.6, R-2.5). O editor só vê texto com `\n` e sem
 * BOM; ao salvar, o estilo original volta. Arquivos puramente LF, CRLF ou CR (Mac clássico) fazem
 * ida e volta byte a byte (CR-05). Arquivos mistos são unificados no estilo dominante, mas só no
 * primeiro salvamento depois de uma edição do usuário (com aviso ao abrir); abrir e fechar sem
 * editar nunca grava (CR-01).
 */
export interface TextFormat {
  readonly eol: '\n' | '\r\n' | '\r';
  readonly bom: boolean;
  /** Mais de um tipo de quebra de linha (CRLF, LF, CR) no arquivo. */
  readonly mixed: boolean;
}

const BOM = '\uFEFF';

export function decodeDocument(raw: string): { doc: string; format: TextFormat } {
  const bom = raw.startsWith(BOM);
  const body = bom ? raw.slice(1) : raw;
  // Contagem sem lookbehind (o WKWebView do macOS < 13.3 não o entende; CR-08).
  const crlf = body.split('\r\n').length - 1;
  const lf = body.split('\n').length - 1 - crlf;
  const cr = body.split('\r').length - 1 - crlf;
  const kinds = [crlf, lf, cr].filter((n) => n > 0).length;
  let eol: TextFormat['eol'] = '\n';
  if (crlf > lf + cr) eol = '\r\n';
  else if (cr > lf + crlf) eol = '\r';
  return {
    doc: body.replace(/\r\n?/g, '\n'),
    format: { eol, bom, mixed: kinds > 1 },
  };
}

export function encodeDocument(doc: string, format: TextFormat): string {
  const body = format.eol === '\n' ? doc : doc.replace(/\n/g, format.eol);
  return format.bom ? BOM + body : body;
}
