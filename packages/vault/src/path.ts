import { VaultError } from './errors';

/** Teto em pontos de código (o `chars().count()` de `policy::validate_rel`), não em UTF-16. */
const MAX_PATH_LENGTH = 1024;
// eslint-disable-next-line no-control-regex -- detectar caracteres de controle é o objetivo
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;
const DRIVE_LETTER = /^[A-Za-z]:/;
const CONFIG_DIR = '.simplemd';

/** `.txt` sem diferença de caixa ASCII (o `has_ext` do Rust). */
const DICTIONARY_EXT = /\.[tT][xX][tT]$/;
/** `/`, `\`, `:` em qualquer lugar; `.` (oculto) ou `~` no início. */
const NAME_STRUCTURE = /[/\\:]|^[.~]/;
/**
 * O que `policy::dictionary_name` recusa num nome, caractere a caractere: controle (`Cc`, C0 e C1);
 * a formatação invisível de `policy::is_format_char` (a categoria `Cf` do Unicode 15.1, lista
 * fechada); os invisíveis de `policy::is_invisible` — todo `Default_Ignorable_Code_Point`, o braille
 * vazio (U+2800), a cabeça de nota nula (U+1D159) e todo espaço (`White_Space`) que não seja o
 * U+0020 —; e metade de par substituto, que nenhuma `String` do Rust carrega.
 */
const NAME_HIDDEN =
  /[\p{Cc}\p{Cs}\p{Default_Ignorable_Code_Point}\u00AD\u0600-\u0605\u061C\u06DD\u070F\u0890\u0891\u08E2\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF\uFFF9-\uFFFB\u{110BD}\u{110CD}\u{13430}-\u{1343F}\u{1BCA0}-\u{1BCA3}\u{1D173}-\u{1D17A}\u{E0001}\u{E0020}-\u{E007F}\u2800\u{1D159}]|(?! )\p{White_Space}/u;
/**
 * Nome de dispositivo do Windows pelo radical (até o 1º `.`, com os espaços do fim): o
 * `is_device_name` do Rust — CONIN$/CONOUT$ e COM¹–³/LPT¹–³ além dos reservados. Sem a flag `u`, o
 * `i` só iguala letras ASCII.
 */
const DEVICE_NAME = /^(con|prn|aux|nul|conin\$|conout\$|(com|lpt)[1-9\u00B9\u00B2\u00B3]) *$/i;

/**
 * O dispositivo do Windows que um segmento abre (`CON` para `con .txt`), ou `undefined`: a regra
 * de `policy::is_device_name`, a mesma do passo 8 de `toVaultPath`, dos dicionários e do nome de
 * nota nova (W3a).
 */
export function windowsDeviceName(segment: string): string | undefined {
  const stem = segment.split('.')[0] as string;
  return DEVICE_NAME.test(stem) ? stem.trimEnd().toUpperCase() : undefined;
}

function invalid(input: string, reason: string): VaultError {
  return new VaultError('INVALID_PATH', `Caminho inválido (${reason}).`, { path: input });
}

function outside(input: string): VaultError {
  return new VaultError('OUTSIDE_VAULT', 'Caminho fora do vault.', { path: input });
}

/**
 * Mais de 1.024 pontos de código, contados como o Rust (`chars().count()`): o par substituto conta
 * um, e a metade solta também. Só percorre o texto entre 1.025 e 2.048 unidades UTF-16.
 */
function tooLong(input: string): boolean {
  if (input.length <= MAX_PATH_LENGTH) return false;
  if (input.length > 2 * MAX_PATH_LENGTH) return true;
  let points = 0;
  for (let i = 0; i < input.length; i++) {
    const unit = input.charCodeAt(i);
    if (unit >= 0xd800 && unit < 0xdc00 && (input.charCodeAt(i + 1) & 0xfc00) === 0xdc00) i++;
    if (++points > MAX_PATH_LENGTH) return true;
  }
  return false;
}

/**
 * Nome de arquivo de dicionário (r32), o espelho de `policy::dictionary_name` conferido pela
 * fixture `test/fixtures/dictionary-names.json` (a mesma do teste Rust): UM segmento que
 * `toVaultPath` aceitaria, terminado em `.txt` (sem diferença de caixa ASCII), até 1.024 pontos de
 * código, sem `/`, `\` ou `:`, sem `.` ou `~` no início, sem os caracteres de `NAME_HIDDEN` e sem
 * nome de dispositivo do Windows (`con .txt`, `COM¹.txt`, `CONIN$.txt`…). NFC não é exigido
 * (D-R36A-FIX-1). Vale para a camada global e para o último segmento de
 * `.simplemd/dictionaries/<nome>.txt`: um nome fora dela nunca chega ao Rust.
 */
export function isDictionaryName(name: string): boolean {
  if (name.length <= '.txt'.length || !DICTIONARY_EXT.test(name) || tooLong(name)) return false;
  if (NAME_STRUCTURE.test(name) || NAME_HIDDEN.test(name)) return false;
  return windowsDeviceName(name) === undefined;
}

/**
 * Guarda de caminho do vault (arch-backend §1.5.3). Pura e síncrona: roda antes de qualquer
 * chamada à porta de arquivos. Recebe um caminho relativo ao vault com `/` como separador e
 * devolve o caminho POSIX relativo normalizado, ou lança `VaultError` com `INVALID_PATH` ou
 * `OUTSIDE_VAULT`. As regras são aplicadas na ordem do documento de arquitetura.
 */
export function toVaultPath(input: string): string {
  // 1. Tamanho 1..1024 pontos de código (como o Rust), sem NUL nem caracteres de controle.
  if (input.length === 0 || tooLong(input)) throw invalid(input, 'tamanho');
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
  if (segments.some((s) => windowsDeviceName(s) !== undefined)) {
    throw invalid(input, 'nome reservado');
  }
  return segments.join('/');
}
