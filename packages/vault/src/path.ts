import { VaultError } from './errors';

const MAX_PATH_LENGTH = 1024;
// eslint-disable-next-line no-control-regex -- detectar caracteres de controle é o objetivo
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;
const DRIVE_LETTER = /^[A-Za-z]:/;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
const CONFIG_DIR = '.simplemd';

function invalid(input: string, reason: string): VaultError {
  return new VaultError('INVALID_PATH', `Caminho inválido (${reason}).`, { path: input });
}

function outside(input: string): VaultError {
  return new VaultError('OUTSIDE_VAULT', 'Caminho fora do vault.', { path: input });
}

/**
 * Guarda de caminho do vault (arch-backend §1.5.3). Pura e síncrona: roda antes de qualquer
 * chamada à porta de arquivos. Recebe um caminho relativo ao vault com `/` como separador e
 * devolve o caminho POSIX relativo normalizado, ou lança `VaultError` com `INVALID_PATH` ou
 * `OUTSIDE_VAULT`. As regras são aplicadas na ordem do documento de arquitetura.
 */
export function toVaultPath(input: string): string {
  // 1. Tamanho 1..1024, sem NUL nem caracteres de controle.
  if (input.length === 0 || input.length > MAX_PATH_LENGTH) throw invalid(input, 'tamanho');
  if (CONTROL_CHARS.test(input)) throw invalid(input, 'caractere de controle');
  // 2. Barra invertida em qualquer posição.
  if (input.includes('\\')) throw invalid(input, 'barra invertida');
  // 3. Caminho absoluto ou enraizado.
  if (input.startsWith('/') || input.startsWith('~') || DRIVE_LETTER.test(input)) {
    throw outside(input);
  }
  const segments = input.split('/');
  // 4. `..` sai do vault; segmento vazio ou `.` é inválido.
  if (segments.includes('..')) throw outside(input);
  if (segments.some((s) => s === '' || s === '.')) throw invalid(input, 'segmento vazio ou "."');
  // 5. Segmentos ocultos, exceto `.simplemd` como primeiro segmento.
  if (segments.some((s, i) => s.startsWith('.') && !(i === 0 && s === CONFIG_DIR))) {
    throw invalid(input, 'segmento oculto');
  }
  // 6. `:` em um segmento (fluxos alternativos do NTFS, como `a.md:x`).
  if (segments.some((s) => s.includes(':'))) throw invalid(input, 'dois-pontos');
  // 7. Segmento terminado em espaço ou ponto (o Windows os remove e cria apelidos).
  if (segments.some((s) => s.endsWith(' ') || s.endsWith('.'))) {
    throw invalid(input, 'termina em espaço ou ponto');
  }
  // 8. Nomes reservados do Windows, para manter o vault portável.
  if (segments.some((s) => WINDOWS_RESERVED.test(s))) throw invalid(input, 'nome reservado');
  return segments.join('/');
}
