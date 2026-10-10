import { normalizeWikiTarget, visibleText, type WikilinkResolution } from '@simplemd/core';
import { newNotePathForWikilink, type NewNoteNameError } from '@simplemd/vault';

/** Nomes dos caracteres proibidos em nome de nota (STR-150). */
const CHAR_NAMES: Record<string, string> = {
  '\\': 'barra invertida',
  ':': 'dois-pontos',
  '*': 'asterisco',
  '?': 'ponto de interrogação',
  '"': 'aspas',
  '<': 'sinal de menor',
  '>': 'sinal de maior',
  '|': 'barra vertical',
};

/**
 * Motivo da recusa do nome (STR-150). `EMPTY`, `PATH_TOO_LONG`, `FORMAT_CHAR` e `NOT_ALLOWED`
 * completam a tabela com textos provisórios para a UX (C-3; RUN r7 docs-notes/S2.md).
 */
function invalidReason(reason: NewNoteNameError, detail: string | undefined): string {
  switch (reason) {
    case 'FORBIDDEN_CHAR':
      return `contém ${detail ?? ''} (${CHAR_NAMES[detail ?? ''] ?? 'caractere proibido'})`;
    case 'CONTROL_CHAR':
      return 'contém caractere de controle';
    case 'FORMAT_CHAR':
      return 'contém caractere invisível';
    case 'DOT_SEGMENT':
      return 'usa . ou .. como pasta';
    case 'HIDDEN_SEGMENT':
      return 'começa com ponto';
    case 'TRAILING_DOT_OR_SPACE':
      return 'termina com ponto ou espaço';
    case 'RESERVED_NAME':
      return `é um nome reservado do Windows (${detail ?? ''})`;
    case 'SEGMENT_TOO_LONG':
      return 'um trecho passa de 255 bytes';
    case 'PATH_TOO_LONG':
      return 'o caminho passa de 1.024 caracteres';
    case 'EMPTY':
      return 'tem um trecho vazio';
    case 'NOT_ALLOWED':
      return 'o caminho não é permitido';
  }
}

/**
 * Textos da criação de nota por wikilink (STR-149/STR-150; DESIGN §R7.6.4). Nomes e caminhos com
 * controle/formatação invisível aparecem codificados (`%HH`; CR-S2-02).
 */
export const NOTE_CREATE_TEXT = {
  created: 'Nota criada:',
  existed: (path: string) => `A nota “${visibleText(path)}” já existia e foi aberta.`,
  failed: (path: string, error: string) =>
    `Não foi possível criar “${visibleText(path)}”: ${error}.`,
  invalid: (name: string, reason: NewNoteNameError, detail?: string) =>
    `Nome de nota inválido: “${visibleText(name)}” — ${invalidReason(reason, detail)}.`,
  /** O provider recusou o caminho (guarda do vault, permissão): também nome inválido, 0 gravações. */
  refused: (name: string) =>
    `Nome de nota inválido: “${visibleText(name)}” — ${invalidReason('NOT_ALLOWED', undefined)}.`,
} as const;

export type WikilinkCreation =
  { readonly ok: true; readonly rel: string } | { readonly ok: false; readonly message: string };

/**
 * Onde o ⌘-clique num wikilink inexistente cria a nota, ou o aviso STR-150 se o nome é recusado.
 * Única função da dica W1 (`LinksIndex.resolve`) e do clique (`link-opener`): CR-S2-03.
 */
export function wikilinkCreation(target: string, fromPath: string | null): WikilinkCreation {
  const name = newNotePathForWikilink(fromPath ?? '', target);
  return name.ok
    ? name
    : { ok: false, message: NOTE_CREATE_TEXT.invalid(target, name.reason, name.detail) };
}

/** Wikilink inexistente para o editor: o caminho de criação ou a recusa (a mesma do clique). */
export function missingWikilink(target: string, fromPath: string | null): WikilinkResolution {
  if (normalizeWikiTarget(target) === '') return { kind: 'missing', createPath: '' };
  const creation = wikilinkCreation(target, fromPath);
  return creation.ok
    ? { kind: 'missing', createPath: creation.rel }
    : { kind: 'missing', createPath: '', refused: creation.message };
}
