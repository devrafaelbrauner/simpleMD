import { toVaultPath } from './path';

/** Motivo da recusa de um nome de nota nova (R-I2.5; arch-backend r7 §1.6). */
export type NewNoteNameError =
  | 'EMPTY'
  | 'FORBIDDEN_CHAR'
  | 'CONTROL_CHAR'
  /** Formatação invisível (`Cf`: bidi, largura zero; CR-S2-02). */
  | 'FORMAT_CHAR'
  | 'DOT_SEGMENT'
  | 'HIDDEN_SEGMENT'
  | 'TRAILING_DOT_OR_SPACE'
  | 'RESERVED_NAME'
  | 'SEGMENT_TOO_LONG'
  | 'PATH_TOO_LONG'
  /** A guarda de caminho do vault recusou (ex.: `~` no início; CR-S2-03). */
  | 'NOT_ALLOWED';

export type NewNotePath =
  | { readonly ok: true; readonly rel: string }
  | {
      readonly ok: false;
      readonly reason: NewNoteNameError;
      /** O caractere proibido (`FORBIDDEN_CHAR`) ou o nome reservado (`RESERVED_NAME`). */
      readonly detail?: string;
    };

const FORBIDDEN = /[\\:*?"<>|]/;
const CONTROL = /\p{Cc}/u;
const FORMAT = /\p{Cf}/u;
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
const SEGMENT_MAX_BYTES = 255;
const PATH_MAX = 1024;
const MD_EXT = /\.md$/i;
const encoder = new TextEncoder();

function checkSegment(segment: string, last: boolean): NewNotePath | null {
  if (segment === '') return { ok: false, reason: 'EMPTY' };
  const forbidden = FORBIDDEN.exec(segment)?.[0];
  if (forbidden !== undefined) return { ok: false, reason: 'FORBIDDEN_CHAR', detail: forbidden };
  if (CONTROL.test(segment)) return { ok: false, reason: 'CONTROL_CHAR' };
  if (FORMAT.test(segment)) return { ok: false, reason: 'FORMAT_CHAR' };
  if (segment === '.' || segment === '..') return { ok: false, reason: 'DOT_SEGMENT' };
  if (segment.startsWith('.')) return { ok: false, reason: 'HIDDEN_SEGMENT' };
  if (/[. ]$/.test(segment)) return { ok: false, reason: 'TRAILING_DOT_OR_SPACE' };
  const reserved = RESERVED.exec(segment)?.[1];
  if (reserved !== undefined)
    return { ok: false, reason: 'RESERVED_NAME', detail: reserved.toUpperCase() };
  const bytes = encoder.encode(last ? `${segment}.md` : segment).length;
  if (bytes > SEGMENT_MAX_BYTES) return { ok: false, reason: 'SEGMENT_TOO_LONG' };
  return null;
}

/**
 * `[[alvo]]` → caminho da nota nova (R-I2.5). Sem `/` → pasta da nota atual; com `/` → a partir da
 * raiz do vault. Apelido e `#Título` já removidos por quem chama. NFC; `.md` final (sem caixa)
 * tirado e reposto. Cada segmento do alvo é validado (caracteres `\ : * ? " < > |` e de controle,
 * `.`/`..`, começo com ponto — inclui `.simplemd` —, ponto ou espaço no fim, nomes reservados do
 * Windows, > 255 bytes UTF-8); o resultado passa ainda pela guarda de caminho do provider.
 */
export function newNotePathForWikilink(currentNotePath: string, target: string): NewNotePath {
  const trimmed = target.trim().normalize('NFC');
  // Qualquer `/` (inclusive só o inicial, `[[/nota]]`) = a partir da raiz (R-I2.5).
  const rooted = trimmed.includes('/');
  const name = trimmed.replace(/^\/+/, '').replace(MD_EXT, '');
  const segments = name.split('/');
  for (let i = 0; i < segments.length; i++) {
    const refused = checkSegment(segments[i] as string, i === segments.length - 1);
    if (refused) return refused;
  }
  const slash = currentNotePath.lastIndexOf('/');
  const folder = rooted || slash < 0 ? '' : currentNotePath.slice(0, slash);
  const rel = folder === '' ? `${name}.md` : `${folder}/${name}.md`;
  if (rel.length > PATH_MAX) return { ok: false, reason: 'PATH_TOO_LONG' };
  try {
    return { ok: true, rel: toVaultPath(rel) };
  } catch {
    // A guarda de caminho do provider recusou o que as regras acima deixaram passar (`~` inicial).
    return { ok: false, reason: 'NOT_ALLOWED' };
  }
}
