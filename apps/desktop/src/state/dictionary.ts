import type {
  DictionaryHost,
  DictionaryLayer,
  DictionaryWriteResult,
} from '@simplemd/plugin-api/internal/host';
import {
  isVaultError,
  sha256Hex,
  toVaultPath,
  type ContentVaultProvider,
  type FsDirItem,
  type VaultHandle,
} from '@simplemd/vault';
import type { DictionaryImported, DictionaryPort } from '../platform/types';
import type { AppStore } from './store';
import type { Clock } from './sync';

/**
 * Dicionário do usuário (r32b; D-P26-03; design-r32 §1): o formato v1 e o serviço que une a camada
 * global (deste computador, `AppPlatform.dictionaries`) e a da pasta aberta
 * (`.simplemd/dictionaries/*.txt`, pelo `vault`). Um só gravador por arquivo: o LanguageTool recebe o
 * serviço pelo arquivo de registro (`services.dictionary`, DA-R7-26) e a lista das Configurações
 * (r32c) usa o mesmo objeto, com o plugin ligado ou não (D-R32-1).
 *
 * Formato v1: UTF-8, um termo por linha, `#` no início = comentário; termo = NFC do texto sem espaços
 * nas pontas, 1–64 caracteres, sem espaço, controle (Cc) ou formatação invisível (Cf, inclusive
 * bidi); a duplicata sai (vale a primeira). O app grava sem BOM e com `\n`; na leitura, um BOM
 * inicial e o `\r` do fim da linha saem.
 *
 * Camadas: `pessoal.txt` primeiro, o resto pela ordem dos bytes do nome (a do Rust). Por camada,
 * até 200.000 termos, 16 arquivos e 20 MiB; até 10 MiB por arquivo (D-R32-2). O excesso fica de fora
 * com um aviso na área de avisos do app, uma vez por camada e motivo em cada sessão (D-R32-7, r35b).
 *
 * Carga sob demanda: nada é lido até a primeira assinatura (ou gravação). Daí em diante, a global é
 * relida a cada pasta aberta e a da pasta na abertura e quando o observador vê um `.txt` dela mudar.
 * Gravação condicional (sha256 da base lida): base velha → relê a camada e tenta mais uma vez.
 *
 * Listas (r33a; design-r33 §1): `import` traz uma lista de termos pelo diálogo nativo do Rust
 * (`dict_import`; o webview nunca vê o caminho), `rename` e `removeList` mexem numa lista da camada
 * (`dict_manage`), nunca no `pessoal.txt`; depois, a camada é relida. Os nomes passam antes pelo
 * espelho da regra do Rust (`isDictionaryName`) e os criados aqui saem em NFC.
 */

export const DICTIONARY_LIMITS = {
  /** Caracteres (pontos de código) por termo. */
  termMaxChars: 64,
  /** Termos por camada (D-R32-2). */
  layerMaxTerms: 200_000,
  /** Arquivos por camada (os com erro contam), como no Rust. */
  layerMaxFiles: 16,
  layerMaxBytes: 20 * 1024 * 1024,
  /** `policy::DICTIONARY_MAX_BYTES`. */
  fileMaxBytes: 10 * 1024 * 1024,
} as const;

/** O único arquivo que o app cria numa camada (D-R32-3); "Adicionar" acrescenta nele. */
export const PERSONAL_DICTIONARY = 'pessoal.txt';
/** A camada da pasta, relativa à raiz da pasta. */
export const FOLDER_DICTIONARY_DIR = '.simplemd/dictionaries';
/** Espera depois do último evento do observador antes de reler a camada da pasta. */
export const DICTIONARY_RELOAD_DEBOUNCE_MS = 300;

/** Espaço, controle, formatação invisível (inclusive bidi) e metade de par substituto. */
const NOT_IN_TERM = /[\p{White_Space}\p{Cc}\p{Cf}\p{Cs}]/u;
/** Controle (C0 e C1) e formatação invisível (bidi, largura zero) num nome de dicionário. */
const NAME_CONTROL = /[\p{Cc}\p{Cf}]/u;
/** Espaço em branco que não é o U+0020 (a propriedade `White_Space`, uma lista estável). */
const NAME_SPACE = /[\t-\r\u0085\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]/;
/**
 * Invisíveis fora de `Cc`/`Cf` (AppSec r36a N1), em pontos de código: o CGJ, os seletores de
 * variação (U+180B–U+180D, U+180F, U+FE00–U+FE0F, U+E0100–U+E01EF), os preenchedores Hangul e o
 * braille vazio. Faixas, não uma classe de regex: são marcas que combinam com o caractere anterior.
 */
const NAME_INVISIBLE: ReadonlyArray<readonly [number, number]> = [
  [0x034f, 0x034f],
  [0x115f, 0x1160],
  [0x180b, 0x180d],
  [0x180f, 0x180f],
  [0x2800, 0x2800],
  [0x3164, 0x3164],
  [0xfe00, 0xfe0f],
  [0xffa0, 0xffa0],
  [0xe0100, 0xe01ef],
];
/** Nome de dispositivo do Windows pelo radical (até o 1º `.`, sem os espaços do fim). */
const DEVICE_NAME = /^(con|prn|aux|nul|conin\$|conout\$|(com|lpt)[1-9\u00B9\u00B2\u00B3])$/;
const MIB = 1024 * 1024;
const LAYER_NAMES: Readonly<Record<DictionaryLayer, string>> = {
  global: 'deste computador',
  folder: 'desta pasta',
};
const encoder = new TextEncoder();

/**
 * O termo do formato v1 que a linha (ou palavra) representa, ou `null`: linha vazia, comentário
 * (`#`), mais de 64 caracteres, espaço, controle ou formatação invisível.
 */
export function normalizeWord(raw: string): string | null {
  const term = raw.trim().normalize('NFC');
  // 64 caracteres em NFC cabem em 128 unidades UTF-16: o corte vem antes de espalhar a linha.
  if (term === '' || term.length > 2 * DICTIONARY_LIMITS.termMaxChars) return null;
  if (term.startsWith('#') || NOT_IN_TERM.test(term)) return null;
  return [...term].length <= DICTIONARY_LIMITS.termMaxChars ? term : null;
}

/** Os termos de um arquivo v1, na ordem, sem duplicatas (vale a primeira ocorrência). */
export function parseWordList(text: string): string[] {
  const terms = new Set<string>();
  const body = text.startsWith('\uFEFF') ? text.slice(1) : text;
  for (const line of body.split('\n')) {
    const term = normalizeWord(line);
    if (term !== null) terms.add(term);
  }
  return [...terms];
}

/** Caixa misturada ("eXcessão"), como `StringTools.isMixedCase` do LanguageTool. */
function isMixedCase(word: string): boolean {
  if (word === word.toLowerCase() || word === word.toUpperCase()) return false;
  const first = String.fromCodePoint(word.codePointAt(0) ?? 0);
  const tail = word.slice(first.length);
  return first === first.toLowerCase() || tail !== tail.toLowerCase();
}

/**
 * A palavra está em `words` (termos em NFC), com a regra do LanguageTool para palavras ignoradas
 * (`SpellingCheckRule.isIgnoredNoCase`): igual ou — sem caixa misturada — a forma em minúsculas
 * está lá. "excessão" aceita "Excessão" e "EXCESSÃO"; "Brasil" não aceita "brasil" (CR-S8 N3). A
 * palavra é comparada em NFC: a nota pode vir decomposta (NFD).
 */
export function inDictionary(words: ReadonlySet<string>, word: string): boolean {
  const term = word.normalize('NFC');
  return words.has(term) || (!isMixedCase(term) && words.has(term.toLowerCase().normalize('NFC')));
}

/** `pessoal.txt` primeiro; o resto pela ordem dos bytes UTF-8 do nome, como no Rust. */
function layerOrder(a: string, b: string): number {
  if (a === PERSONAL_DICTIONARY || b === PERSONAL_DICTIONARY)
    return a === b ? 0 : a === PERSONAL_DICTIONARY ? -1 : 1;
  const x = encoder.encode(a);
  const y = encoder.encode(b);
  for (let i = 0; i < x.length && i < y.length; i++) {
    const diff = (x[i] ?? 0) - (y[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return x.length - y.length;
}

/** Minúsculas só no ASCII (o `to_ascii_lowercase` do Rust). */
function asciiLower(text: string): string {
  return text.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

/**
 * Espelho de `policy::dictionary_name` do Rust (r36a e a correção N1; AppSec r36a N2): UM segmento de
 * caminho válido terminado em `.txt` (sem diferença de caixa ASCII), até 1.024 caracteres, sem `/`,
 * `\`, `:`, `~` ou `.` no início, sem controle (C0, C1), formatação invisível (`Cf`: bidi, largura
 * zero), os invisíveis de fora dela (CGJ, seletores de variação, preenchedores Hangul, braille vazio)
 * nem espaço que não seja o U+0020, e sem nome de dispositivo do Windows (`con .txt`, `COM¹.txt`,
 * `CONIN$.txt`…). NFC não é exigido (D-R36A-FIX-1): os nomes criados pelo app saem em NFC
 * (`listFileName`). Vale para mostrar e para pedir: um nome fora dela nunca chega ao Rust.
 */
export function isDictionaryName(name: string): boolean {
  if (name.length <= '.txt'.length || asciiLower(name.slice(-4)) !== '.txt') return false;
  const points = [...name].map((c) => c.codePointAt(0) ?? 0);
  if (points.length > 1024 || /[/\\:]/.test(name) || /^[.~]/.test(name)) return false;
  if (NAME_CONTROL.test(name) || NAME_SPACE.test(name)) return false;
  if (points.some((p) => NAME_INVISIBLE.some(([from, to]) => p >= from && p <= to))) return false;
  const stem = asciiLower(name.split('.')[0] ?? '').replace(/ +$/, '');
  return !DEVICE_NAME.test(stem);
}

/**
 * O `pessoal.txt` da camada em qualquer caixa Unicode, não só ASCII (como o `PROTECTED` do Rust,
 * AppSec r33a N1): `PESSOAL.TXT` e `peſsoal.txt` (o `ſ` vira `S`) abrem o mesmo arquivo no APFS e no
 * NTFS; e as minúsculas postas em maiúsculas (review r33a c1 NB-3), para o `ẞ` (U+1E9E, maiúscula de
 * si mesmo) de `PEẞOAL.TXT`, que vira `ß` e depois `SS`.
 */
function isPersonal(name: string): boolean {
  const personal = PERSONAL_DICTIONARY.toUpperCase();
  return (
    name.toUpperCase() === personal ||
    name.toLowerCase() === PERSONAL_DICTIONARY ||
    name.toLowerCase().toUpperCase() === personal
  );
}

/** Renomear PARA o `pessoal.txt` (o `PROTECTED` do destino): a mensagem fala do nome, não da lista. */
const RESERVED_NAME_MESSAGE = '“pessoal” é o nome do dicionário pessoal; escolha outro nome.';

/**
 * Nome de arquivo de uma lista a partir do que a pessoa digitou (r33a): sem os espaços das pontas,
 * sem o `.txt` se ele veio, em NFC (o Rust não exige NFC, D-R36A-FIX-1) e com `.txt`. Fora da regra
 * de nomes (`isDictionaryName`) → `null`.
 */
export function listFileName(typed: string): string | null {
  let stem = typed.trim();
  if (stem.length > '.txt'.length && asciiLower(stem.slice(-4)) === '.txt')
    stem = stem.slice(0, -4);
  const name = `${stem.normalize('NFC')}.txt`;
  return isDictionaryName(name) ? name : null;
}

/** Nome de dicionário da pasta: a regra de nomes e o caminho inteiro aceito pela guarda do vault. */
function isFolderDictionaryName(name: string): boolean {
  if (!isDictionaryName(name)) return false;
  const path = `${FOLDER_DICTIONARY_DIR}/${name}`;
  try {
    return toVaultPath(path) === path;
  } catch {
    return false;
  }
}

/** Controle e formatação invisível de um texto vindo de arquivo, trocados antes de mostrar. */
function shown(text: string): string {
  return text.replace(/[\p{Cc}\p{Cf}]/gu, '\uFFFD');
}

/** Megabytes com uma casa, arredondados para cima (10 MiB + 1 byte não vira "10 MB"). */
function megabytes(bytes: number): string {
  return (Math.ceil((bytes / MIB) * 10) / 10).toLocaleString('pt-BR');
}

function field(detail: unknown, key: string): unknown {
  return typeof detail === 'object' && detail !== null && key in detail
    ? (detail as Record<string, unknown>)[key]
    : undefined;
}

/**
 * Mensagem pt-BR de um erro de importar, renomear ou remover lista (r33a), pelo código e pelo
 * `detail` do Rust (ou do falso): nunca um caminho; o nome do arquivo e a codificação vêm do arquivo
 * escolhido e só entram como texto, sem controles.
 */
export function dictionaryErrorMessage(
  code: string,
  detail?: unknown,
  layer?: DictionaryLayer,
): string {
  const where = layer === undefined ? '' : ` ${LAYER_NAMES[layer]}`;
  switch (code) {
    case 'TOO_LARGE': {
      const fileName = field(detail, 'fileName');
      const size = field(detail, 'size');
      const max = field(detail, 'max');
      const limit = megabytes(typeof max === 'number' ? max : DICTIONARY_LIMITS.fileMaxBytes);
      return typeof fileName === 'string' && typeof size === 'number'
        ? `“${shown(fileName)}” tem ${megabytes(size)} MB; o limite é ${limit} MB.`
        : `O arquivo passa do limite de ${limit} MB.`;
    }
    case 'UNSUPPORTED_TYPE':
      return 'Escolha um arquivo .txt (uma palavra por linha) ou um .dic do Hunspell.';
    case 'SYMLINK':
      return 'O arquivo escolhido é um link; escolha o próprio arquivo.';
    case 'NOT_TEXT':
      return 'O arquivo escolhido não é texto.';
    case 'UNSUPPORTED_ENCODING': {
      const encoding = field(detail, 'encoding');
      const named = typeof encoding === 'string' && encoding !== '' ? ` “${shown(encoding)}”` : '';
      return `A codificação${named} declarada no .aff não é suportada (use UTF-8, ISO8859-1, ISO8859-15 ou microsoft-cp1252).`;
    }
    case 'BAD_ENCODING': {
      const encoding = field(detail, 'encoding');
      return `O arquivo não está em ${typeof encoding === 'string' ? shown(encoding) : 'UTF-8'}, a codificação declarada.`;
    }
    case 'EMPTY':
      return 'Nenhuma palavra válida no arquivo.';
    case 'LAYER_FULL':
      return `O dicionário${where} chegou a um limite (${DICTIONARY_LIMITS.layerMaxFiles} listas, ${DICTIONARY_LIMITS.layerMaxTerms.toLocaleString('pt-BR')} palavras ou ${DICTIONARY_LIMITS.layerMaxBytes / MIB} MB); remova uma lista antes de importar.`;
    case 'BUSY':
      return 'Já há uma importação em andamento.';
    case 'ALREADY_EXISTS':
      return 'Já existe uma lista com esse nome.';
    case 'NOT_FOUND':
      return 'A lista não existe mais.';
    case 'PROTECTED':
      return 'O pessoal.txt não pode ser renomeado nem removido.';
    case 'INVALID_NAME':
      return 'Nome inválido: sem barra, dois-pontos, ponto no início, caracteres invisíveis nem nome reservado do Windows.';
    case 'NO_VAULT':
      return 'Nenhuma pasta aberta.';
    case 'VAULT_CLOSED':
      return 'A pasta foi fechada.';
    case 'OUTSIDE_VAULT':
      return 'Um link no caminho do dicionário foi recusado; nada foi gravado.';
    case 'PERMISSION_DENIED':
      return 'Sem permissão para gravar no dicionário.';
    case 'INVALID_PATH':
      return 'O arquivo escolhido ou a pasta do dicionário não é válido.';
    default:
      return `Não foi possível concluir (${shown(code)}).`;
  }
}

/**
 * O resumo de uma importação (r33a; design-r33 §1): "“termos-medicos” importado: 50.000 palavras,
 * 3 descartadas (lido como ISO-8859-1)." O nome é o do arquivo criado, sem o `.txt`.
 */
export function importSummary({ name, words, discarded, encoding }: DictionaryImported): string {
  const list = shown(name.replace(/\.txt$/i, ''));
  const count = `${words.toLocaleString('pt-BR')} ${words === 1 ? 'palavra' : 'palavras'}`;
  const dropped =
    discarded === 0
      ? ''
      : `, ${discarded.toLocaleString('pt-BR')} ${discarded === 1 ? 'descartada' : 'descartadas'}`;
  return `“${list}” importado: ${count}${dropped} (lido como ${shown(encoding)}).`;
}

/** Bytes UTF-8 sem codificar (metade de par vira U+FFFD no `TextEncoder`: 3 bytes). */
function utf8Length(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit < 0x80) bytes += 1;
    else if (unit < 0x800) bytes += 2;
    else if (unit >= 0xd800 && unit < 0xdc00 && (text.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
}

/** O texto sem as linhas do termo, ou `null` se ele não está lá (comentários e o resto ficam). */
function withoutTerm(text: string, term: string): string | null {
  const lines = text.split('\n');
  const kept = lines.filter((line) => normalizeWord(line) !== term);
  return kept.length === lines.length ? null : kept.join('\n');
}

function codeOf(error: unknown): string {
  return typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
    ? error.code
    : 'IO';
}

/** Mensagem do erro (a do Rust e a do vault não têm caminho). */
function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof error.message === 'string'
    ? error.message
    : String(error);
}

/** A base ficou velha: o arquivo mudou, sumiu ou nasceu desde a leitura. */
function isStale(error: unknown): boolean {
  const code = codeOf(error);
  return code === 'CONFLICT' || code === 'ALREADY_EXISTS' || code === 'NOT_FOUND';
}

function fileProblem(code: string): string {
  switch (code) {
    case 'TOO_LARGE':
      return `passa de ${DICTIONARY_LIMITS.fileMaxBytes / MIB} MiB`;
    case 'NOT_UTF8':
      return 'não está em UTF-8';
    case 'OUTSIDE_VAULT':
      return 'é um link';
    default:
      return 'não pôde ser lido';
  }
}

/** Camada como foi lida: os arquivos legíveis em ordem, os com erro e os deixados de fora. */
interface RawFile {
  readonly name: string;
  readonly text: string;
  /** Global: sha256 dos bytes (do Rust). Pasta: `null` — a base vai como `{ mtime, text }`. */
  readonly sha256: string | null;
  readonly mtime: number;
}

interface RawLayer {
  readonly files: readonly RawFile[];
  readonly errors: readonly { readonly name: string; readonly code: string }[];
  readonly skipped: number;
}

const EMPTY_RAW: RawLayer = { files: [], errors: [], skipped: 0 };

/** O `pessoal.txt` lido: a base da próxima gravação e o tamanho em bytes. */
interface Personal extends RawFile {
  readonly bytes: number;
}

/**
 * `idle` = ainda não lida; `loading` = primeira leitura; `ready`; `error` = a última leitura falhou
 * (os termos são os da anterior); `none` = camada da pasta sem pasta aberta.
 */
export type DictionaryLayerStatus = 'idle' | 'loading' | 'ready' | 'error' | 'none';

/**
 * Por que uma camada avisa: `file` = um arquivo ficou de fora (grande demais, não UTF-8, link,
 * erro de leitura); `skipped` = passou de 16 arquivos ou 20 MiB; `terms` = passou de 200.000
 * termos; `read` = a leitura da camada falhou.
 */
export type DictionaryWarningReason = 'file' | 'skipped' | 'terms' | 'read';

/** Aviso de uma camada; o `id` não muda enquanto a causa durar. */
export interface DictionaryWarning {
  readonly id: string;
  readonly layer: DictionaryLayer;
  readonly reason: DictionaryWarningReason;
  /** pt-BR, sem caminho absoluto, em minúsculas (vira frase no aviso do app e na lista). */
  readonly text: string;
}

interface LayerData {
  readonly status: DictionaryLayerStatus;
  readonly terms: ReadonlySet<string>;
  /** `undefined`: não existe (a gravação cria); `{ error }`: existe, mas não pôde ser lido. */
  readonly personal: Personal | { readonly error: string } | undefined;
  readonly warnings: readonly DictionaryWarning[];
  readonly files: readonly DictionaryFileView[];
}

/**
 * Uma lista da camada para "Listas importadas" (r33a): o nome do arquivo (`termos-medicos.txt`) e
 * as palavras dele, sem repetidas (`null` = o arquivo não pôde ser lido: link, grande demais, não
 * UTF-8). O `pessoal.txt` não entra: ele não se renomeia nem se remove.
 */
export interface DictionaryFileView {
  readonly name: string;
  readonly words: number | null;
}

/** Uma camada para quem a mostra (lista das Configurações, r32c; listas da r33). */
export interface DictionaryLayerView {
  readonly status: DictionaryLayerStatus;
  /** Na ordem dos arquivos, sem duplicatas, até o teto. */
  readonly terms: readonly string[];
  readonly warnings: readonly DictionaryWarning[];
  /** As listas da camada (fora `pessoal.txt`), na ordem dos arquivos. */
  readonly files: readonly DictionaryFileView[];
}

/** Imutável; um objeto novo a cada mudança (`useSyncExternalStore`). */
export interface DictionarySnapshot {
  readonly global: DictionaryLayerView;
  readonly folder: DictionaryLayerView;
}

/** Remoção (D-R32-6): `absent` = o termo não estava em nenhum arquivo lido da camada. */
export type DictionaryRemoveResult =
  | { readonly status: 'removed' | 'absent' | 'invalid' | 'no-folder' }
  | { readonly status: 'failed'; readonly message: string };

/** Falha de uma operação de lista (r33a): o código do Rust e a mensagem pt-BR dele. */
export interface DictionaryListFailure {
  readonly status: 'failed';
  readonly code: string;
  readonly message: string;
}

/**
 * Importação (r33a): `imported` com o que o Rust devolveu e o resumo pronto para a região de status;
 * `cancelled` = o diálogo foi fechado (nada mudou); `no-folder` = camada da pasta sem pasta aberta.
 */
export type DictionaryImportResult =
  | (DictionaryImported & { readonly status: 'imported'; readonly summary: string })
  | { readonly status: 'cancelled' | 'no-folder' }
  | DictionaryListFailure;

/** Renomear (`renamed`, com o nome novo) ou remover (`removed`) uma lista (r33a). */
export type DictionaryListResult =
  | { readonly status: 'renamed'; readonly name: string }
  | { readonly status: 'removed' | 'no-folder' }
  | DictionaryListFailure;

const EMPTY_TERMS: ReadonlySet<string> = new Set();
const IDLE: LayerData = {
  status: 'idle',
  terms: EMPTY_TERMS,
  personal: undefined,
  warnings: [],
  files: [],
};
const NO_FOLDER: LayerData = { ...IDLE, status: 'none' };

function failure(code: string, detail: unknown, layer: DictionaryLayer): DictionaryListFailure {
  return { status: 'failed', code, message: dictionaryErrorMessage(code, detail, layer) };
}

/** Por que um nome de lista não chega ao Rust: fora da regra de nomes ou o `pessoal.txt`. */
function listRefusal(name: string): 'INVALID_NAME' | 'PROTECTED' | null {
  if (!isDictionaryName(name)) return 'INVALID_NAME';
  return isPersonal(name) ? 'PROTECTED' : null;
}

/** Termos, avisos, listas e base do `pessoal.txt` de uma camada lida (tetos aplicados). */
function buildLayer(layer: DictionaryLayer, raw: RawLayer): LayerData {
  const terms = new Set<string>();
  const files: DictionaryFileView[] = [];
  let overflow = false;
  for (const file of raw.files) {
    const list = parseWordList(file.text);
    if (!isPersonal(file.name)) files.push({ name: file.name, words: list.length });
    for (const term of overflow ? [] : list) {
      if (terms.has(term)) continue;
      if (terms.size === DICTIONARY_LIMITS.layerMaxTerms) {
        overflow = true;
        break;
      }
      terms.add(term);
    }
  }
  for (const { name } of raw.errors) if (!isPersonal(name)) files.push({ name, words: null });
  files.sort((a, b) => layerOrder(a.name, b.name));
  const where = LAYER_NAMES[layer];
  const warnings: DictionaryWarning[] = raw.errors.map(({ name, code }) => ({
    id: `${layer}:file:${name}`,
    layer,
    reason: 'file',
    text: `o arquivo “${shown(name)}” do dicionário ${where} ficou de fora: ${fileProblem(code)}.`,
  }));
  if (raw.skipped > 0)
    warnings.push({
      id: `${layer}:skipped`,
      layer,
      reason: 'skipped',
      text: `o dicionário ${where} passa de ${DICTIONARY_LIMITS.layerMaxFiles} arquivos ou ${DICTIONARY_LIMITS.layerMaxBytes / MIB} MiB: ${raw.skipped === 1 ? '1 arquivo ficou' : `${raw.skipped} arquivos ficaram`} de fora.`,
    });
  if (overflow)
    warnings.push({
      id: `${layer}:terms`,
      layer,
      reason: 'terms',
      text: `o dicionário ${where} passa de ${DICTIONARY_LIMITS.layerMaxTerms.toLocaleString('pt-BR')} palavras: as que sobraram ficaram de fora.`,
    });
  const file = raw.files.find((f) => f.name === PERSONAL_DICTIONARY);
  const error = raw.errors.find((e) => e.name === PERSONAL_DICTIONARY);
  return {
    status: 'ready',
    terms,
    personal: file
      ? { ...file, bytes: utf8Length(file.text) }
      : error
        ? { error: error.code }
        : undefined,
    warnings,
    files,
  };
}

/** Camada de uma operação; a da pasta guarda a pasta e a geração em que foi pedida. */
type Target =
  | { readonly layer: 'global' }
  | { readonly layer: 'folder'; readonly handle: VaultHandle; readonly generation: number };

const GLOBAL_TARGET: Target = { layer: 'global' };

export interface DictionaryServiceDeps {
  /** Camada global (`AppPlatform.dictionaries`: `dict_global_read`/`dict_global_write`). */
  readonly port: DictionaryPort;
  /** Camada da pasta (`AppPlatform.vault`, classe `.simplemd/dictionaries/<nome>.txt`). */
  readonly vault: ContentVaultProvider;
  readonly clock: Clock;
  /** A área de avisos do app: os avisos das camadas (D-R32-7, `pushNotice('dictionary-limit')`). */
  readonly store: AppStore;
}

export class DictionaryService implements DictionaryHost {
  readonly #deps: DictionaryServiceDeps;
  readonly #listeners = new Set<() => void>();
  /** `camada:motivo` já avisados nesta sessão (D-R32-7): nunca saem. */
  readonly #noticed = new Set<string>();
  readonly #views = new WeakMap<LayerData, DictionaryLayerView>();
  /** Fila por camada: cargas e gravações da mesma camada nunca se intercalam. */
  readonly #queues: Record<DictionaryLayer, Promise<unknown>> = {
    global: Promise.resolve(),
    folder: Promise.resolve(),
  };
  #layers: Readonly<Record<DictionaryLayer, LayerData>> = { global: IDLE, folder: NO_FOLDER };
  #union: ReadonlySet<string> = EMPTY_TERMS;
  #snapshot: DictionarySnapshot | null = null;
  #started = false;
  #handle: VaultHandle | null = null;
  /** Muda a cada troca de pasta: o que foi pedido para a anterior não toca a camada da nova. */
  #generation = 0;
  #unwatch: (() => void) | null = null;
  #reload: unknown = null;

  constructor(deps: DictionaryServiceDeps) {
    this.#deps = deps;
  }

  /** Pasta aberta (gancho `afterOpen`): com o serviço em uso, relê as duas camadas e observa. */
  open(handle: VaultHandle): void {
    this.#detach();
    this.#handle = handle;
    this.#setLayer('folder', IDLE);
    if (!this.#started) return;
    this.#watch(handle);
    void this.#enqueue('global', () => this.#refresh(GLOBAL_TARGET));
    void this.#loadFolder();
  }

  /** Pasta fechada (gancho `beforeClose`): a camada da pasta sai da união. */
  close(): void {
    this.#detach();
    this.#handle = null;
    if (this.#layers.folder !== NO_FOLDER) this.#setLayer('folder', NO_FOLDER);
  }

  known(word: string): boolean {
    return inDictionary(this.#union, word);
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    this.#start();
    return () => {
      this.#listeners.delete(listener);
    };
  }

  getSnapshot(): DictionarySnapshot {
    this.#snapshot ??= {
      global: this.#view(this.#layers.global),
      folder: this.#view(this.#layers.folder),
    };
    return this.#snapshot;
  }

  /** Começa a carga, se preciso, e espera as cargas e gravações já pedidas. */
  async ready(): Promise<void> {
    this.#start();
    await Promise.all([this.#queues.global, this.#queues.folder]);
  }

  add(word: string, layer: DictionaryLayer): Promise<DictionaryWriteResult> {
    const term = normalizeWord(word);
    return term === null ? Promise.resolve({ status: 'invalid' }) : this.#append(layer, [term]);
  }

  async addAll(
    words: readonly string[],
    layer: DictionaryLayer,
  ): Promise<DictionaryWriteResult & { readonly rejected: readonly string[] }> {
    const terms: string[] = [];
    const rejected: string[] = [];
    for (const word of words) {
      const term = normalizeWord(word);
      if (term === null) rejected.push(word);
      else terms.push(term);
    }
    const result: DictionaryWriteResult =
      terms.length === 0 ? { status: 'exists' } : await this.#append(layer, terms);
    return { ...result, rejected };
  }

  /**
   * Tira o termo de todos os arquivos lidos da camada (D-R32-6), relendo-a antes; os comentários e
   * as outras linhas ficam. Nunca rejeita.
   */
  remove(word: string, layer: DictionaryLayer): Promise<DictionaryRemoveResult> {
    const term = normalizeWord(word);
    if (term === null) return Promise.resolve({ status: 'invalid' });
    this.#start();
    const target = this.#target(layer);
    if (target === null) return Promise.resolve({ status: 'no-folder' });
    return this.#enqueue(layer, async (): Promise<DictionaryRemoveResult> => {
      for (let attempt = 0; ; attempt++) {
        if (this.#stale(target)) return { status: 'no-folder' };
        let raw: RawLayer;
        try {
          raw =
            target.layer === 'global'
              ? await this.#readGlobal()
              : await this.#readFolder(target.handle);
        } catch (error) {
          return { status: 'failed', message: messageOf(error) };
        }
        if (this.#stale(target)) return { status: 'no-folder' };
        const edits = raw.files.flatMap((file) => {
          const text = withoutTerm(file.text, term);
          return text === null ? [] : [{ file, text }];
        });
        if (edits.length === 0) {
          this.#setLayer(layer, buildLayer(layer, raw));
          return { status: 'absent' };
        }
        try {
          for (const { file, text } of edits) await this.#writeFile(target, file.name, text, file);
        } catch (error) {
          if (attempt === 0 && isStale(error)) continue;
          await this.#refresh(target);
          return { status: 'failed', message: messageOf(error) };
        }
        await this.#refresh(target);
        return { status: 'removed' };
      }
    }).catch((error: unknown) => ({ status: 'failed' as const, message: messageOf(error) }));
  }

  /**
   * Importa uma lista de termos para a camada (r33a; design-r33 §1): o diálogo nativo é do Rust (o
   * webview nunca vê o caminho), a lista vira um `<nome>.txt` novo da camada e a camada é relida.
   * Cancelar → `cancelled`, nada muda. Nunca rejeita.
   */
  async import(layer: DictionaryLayer): Promise<DictionaryImportResult> {
    this.#start();
    const target = this.#target(layer);
    if (target === null) return { status: 'no-folder' };
    let imported: DictionaryImported | null;
    try {
      imported = await this.#deps.port.import(layer);
    } catch (error) {
      return failure(codeOf(error), field(error, 'detail'), layer);
    }
    if (imported === null) return { status: 'cancelled' };
    await this.#enqueue(layer, () => this.#refresh(target));
    return { ...imported, status: 'imported', summary: importSummary(imported) };
  }

  /**
   * Renomeia a lista `name` da camada para `to` — o que a pessoa digitou, que vira `<nome>.txt` em
   * NFC (`listFileName`) — com o par `.dic`/`.aff` (r33a, D-R33-7), e relê a camada. Nome fora da
   * regra → `INVALID_NAME` e `pessoal.txt` → `PROTECTED`, sem chegar ao Rust. Nunca rejeita.
   */
  rename(layer: DictionaryLayer, name: string, to: string): Promise<DictionaryListResult> {
    const next = listFileName(to);
    const own = listRefusal(name);
    const into = next === null ? 'INVALID_NAME' : listRefusal(next);
    const refused = own ?? into;
    if (refused !== null || next === null) {
      const refusal = failure(refused ?? 'INVALID_NAME', undefined, layer);
      return Promise.resolve(
        own === null && into === 'PROTECTED'
          ? { ...refusal, message: RESERVED_NAME_MESSAGE }
          : refusal,
      );
    }
    if (next === name) return Promise.resolve({ status: 'renamed', name });
    return this.#manageList(layer, () => this.#deps.port.rename(layer, name, next), {
      status: 'renamed',
      name: next,
    });
  }

  /** Remove a lista `name` da camada, com o par (r33a, D-R33-7), e relê a camada. Nunca rejeita. */
  removeList(layer: DictionaryLayer, name: string): Promise<DictionaryListResult> {
    const refused = listRefusal(name);
    if (refused !== null) return Promise.resolve(failure(refused, undefined, layer));
    return this.#manageList(layer, () => this.#deps.port.remove(layer, name), {
      status: 'removed',
    });
  }

  // --- interno ---------------------------------------------------------------------------------

  #start(): void {
    if (this.#started) return;
    this.#started = true;
    // Só o falso do harness avisa (`reset()`; r32c, N3): a camada global trocou por fora.
    this.#deps.port.onExternalChange?.(
      () => void this.#enqueue('global', () => this.#refresh(GLOBAL_TARGET)),
    );
    void this.#enqueue('global', () => this.#refresh(GLOBAL_TARGET));
    const handle = this.#handle;
    if (handle === null) return;
    this.#watch(handle);
    void this.#loadFolder();
  }

  #detach(): void {
    this.#generation++;
    this.#unwatch?.();
    this.#unwatch = null;
    if (this.#reload !== null) this.#deps.clock.clearTimeout(this.#reload);
    this.#reload = null;
  }

  /** `.txt` da pasta mudou por fora (outro programa, sincronização): relê a camada da pasta. */
  #watch(handle: VaultHandle): void {
    const { vault, clock } = this.#deps;
    if (!vault.watch) return;
    const prefix = `${FOLDER_DICTIONARY_DIR}/`;
    this.#unwatch = vault.watch(handle, (event) => {
      if (handle !== this.#handle || event.kind !== 'change') return;
      if (!event.paths.some((path) => path.startsWith(prefix))) return;
      if (this.#reload !== null) clock.clearTimeout(this.#reload);
      this.#reload = clock.setTimeout(() => {
        this.#reload = null;
        void this.#loadFolder();
      }, DICTIONARY_RELOAD_DEBOUNCE_MS);
    });
  }

  /** Renomear ou remover uma lista na fila da camada; a camada é relida depois, dê certo ou não. */
  #manageList(
    layer: DictionaryLayer,
    call: () => Promise<void>,
    done: DictionaryListResult,
  ): Promise<DictionaryListResult> {
    this.#start();
    const target = this.#target(layer);
    if (target === null) return Promise.resolve({ status: 'no-folder' });
    return this.#enqueue(layer, async (): Promise<DictionaryListResult> => {
      if (this.#stale(target)) return { status: 'no-folder' };
      let result = done;
      try {
        await call();
      } catch (error) {
        result = failure(codeOf(error), field(error, 'detail'), layer);
      }
      await this.#refresh(target);
      return result;
    }).catch((error: unknown) => failure(codeOf(error), field(error, 'detail'), layer));
  }

  #enqueue<T>(layer: DictionaryLayer, task: () => Promise<T>): Promise<T> {
    const run = this.#queues[layer].then(task);
    this.#queues[layer] = run.catch(() => undefined);
    return run;
  }

  #target(layer: DictionaryLayer): Target | null {
    if (layer === 'global') return GLOBAL_TARGET;
    const handle = this.#handle;
    return handle === null ? null : { layer, handle, generation: this.#generation };
  }

  #stale(target: Target): boolean {
    return target.layer === 'folder' && target.generation !== this.#generation;
  }

  #loadFolder(): Promise<unknown> {
    const target = this.#target('folder');
    return target === null
      ? Promise.resolve()
      : this.#enqueue('folder', () => this.#refresh(target));
  }

  /** Relê a camada e publica; devolve a mensagem do erro de leitura (ou `null`). */
  async #refresh(target: Target): Promise<string | null> {
    if (this.#stale(target)) return null;
    const { layer } = target;
    const before = this.#layers[layer];
    if (before.status === 'idle') this.#setLayer(layer, { ...before, status: 'loading' });
    try {
      const raw =
        target.layer === 'global'
          ? await this.#readGlobal()
          : await this.#readFolder(target.handle);
      if (!this.#stale(target)) this.#setLayer(layer, buildLayer(layer, raw));
      return null;
    } catch (error) {
      if (!this.#stale(target))
        this.#setLayer(layer, {
          ...this.#layers[layer],
          status: 'error',
          warnings: [
            {
              id: `${layer}:read`,
              layer,
              reason: 'read',
              text: `não foi possível ler o dicionário ${LAYER_NAMES[layer]} (${codeOf(error)}).`,
            },
          ],
        });
      return messageOf(error);
    }
  }

  async #readGlobal(): Promise<RawLayer> {
    const layer = await this.#deps.port.readGlobal();
    const files: RawFile[] = [];
    const errors: { name: string; code: string }[] = [];
    for (const file of layer.files) {
      if ('error' in file) errors.push({ name: file.name, code: file.error });
      else files.push({ name: file.name, text: file.text, sha256: file.sha256, mtime: 0 });
    }
    return { files, errors, skipped: layer.skipped };
  }

  /**
   * Os `.txt` da pasta com a semântica da leitura global do Rust: link → `OUTSIDE_VAULT`; acima de
   * 10 MiB → `TOO_LARGE` (0 leituras); 16 entradas (as com erro contam) e 20 MiB pelo `stat` antes
   * de ler — o que passa fica em `skipped`.
   */
  async #readFolder(handle: VaultHandle): Promise<RawLayer> {
    const { vault } = this.#deps;
    let items: FsDirItem[];
    try {
      items = await vault.listChildren(handle, FOLDER_DICTIONARY_DIR);
    } catch (error) {
      if (isVaultError(error, 'NOT_FOUND')) return EMPTY_RAW;
      throw error;
    }
    const files: RawFile[] = [];
    const errors: { name: string; code: string }[] = [];
    let skipped = 0;
    let budget: number = DICTIONARY_LIMITS.layerMaxBytes;
    const candidates = items
      .filter((item) => isFolderDictionaryName(item.name))
      .sort((a, b) => layerOrder(a.name, b.name));
    for (const { name, kind } of candidates) {
      if (files.length + errors.length === DICTIONARY_LIMITS.layerMaxFiles) {
        skipped++;
        continue;
      }
      if (kind === 'symlink') {
        errors.push({ name, code: 'OUTSIDE_VAULT' });
        continue;
      }
      if (kind !== 'file') continue;
      const path = `${FOLDER_DICTIONARY_DIR}/${name}`;
      try {
        const stat = await vault.stat(handle, path);
        if (stat === null || stat.kind !== 'file') continue; // sumiu ou virou pasta
        if (stat.size > DICTIONARY_LIMITS.fileMaxBytes) {
          errors.push({ name, code: 'TOO_LARGE' });
          continue;
        }
        if (stat.size > budget) {
          skipped++;
          continue;
        }
        budget -= stat.size;
        const { text, mtime } = await vault.read(handle, path);
        files.push({ name, text, sha256: null, mtime });
      } catch (error) {
        if (!isVaultError(error, 'NOT_FOUND')) errors.push({ name, code: codeOf(error) });
      }
    }
    return { files, errors, skipped };
  }

  /** Grava `name` na camada: sem base só cria; com base, só se o arquivo ainda for o lido. */
  async #writeFile(
    target: Target,
    name: string,
    text: string,
    base: RawFile | undefined,
  ): Promise<RawFile> {
    if (target.layer === 'global') {
      const expected =
        base === undefined ? null : (base.sha256 ?? sha256Hex(encoder.encode(base.text)));
      await this.#deps.port.writeGlobal(name, text, expected);
      return { name, text, sha256: sha256Hex(encoder.encode(text)), mtime: 0 };
    }
    const { vault } = this.#deps;
    const path = `${FOLDER_DICTIONARY_DIR}/${name}`;
    const { mtime } =
      base === undefined
        ? await vault.write(target.handle, path, text)
        : await vault.writeIfUnchanged(target.handle, path, text, {
            mtime: base.mtime,
            text: base.text,
          });
    return { name, text, sha256: null, mtime };
  }

  /** Acrescenta os termos (já normalizados) ao `pessoal.txt` da camada, numa gravação só. */
  #append(layer: DictionaryLayer, terms: readonly string[]): Promise<DictionaryWriteResult> {
    this.#start();
    const target = this.#target(layer);
    if (target === null) return Promise.resolve({ status: 'no-folder' });
    return this.#enqueue(layer, async (): Promise<DictionaryWriteResult> => {
      for (let attempt = 0; ; attempt++) {
        if (this.#stale(target)) return { status: 'no-folder' };
        if (this.#layers[layer].status !== 'ready') {
          const failure = await this.#refresh(target);
          if (failure !== null) return { status: 'failed', message: failure };
          if (this.#stale(target)) return { status: 'no-folder' };
        }
        const data = this.#layers[layer];
        const fresh = [...new Set(terms)].filter((term) => !data.terms.has(term));
        if (fresh.length === 0) return { status: 'exists' };
        if (data.terms.size + fresh.length > DICTIONARY_LIMITS.layerMaxTerms)
          return { status: 'full' };
        const { personal } = data;
        if (personal !== undefined && 'error' in personal)
          return {
            status: 'failed',
            message: `o ${PERSONAL_DICTIONARY} ${fileProblem(personal.error)}`,
          };
        const before = personal?.text ?? '';
        const addition = `${before === '' || before.endsWith('\n') ? '' : '\n'}${fresh.join('\n')}\n`;
        const bytes = (personal?.bytes ?? 0) + utf8Length(addition);
        if (bytes > DICTIONARY_LIMITS.fileMaxBytes) return { status: 'full' };
        let written: RawFile;
        try {
          written = await this.#writeFile(target, PERSONAL_DICTIONARY, before + addition, personal);
        } catch (error) {
          if (attempt === 0 && isStale(error) && (await this.#refresh(target)) === null) continue;
          return { status: 'failed', message: messageOf(error) };
        }
        if (!this.#stale(target)) {
          const current = this.#layers[layer];
          const next = new Set(current.terms);
          for (const term of fresh) next.add(term);
          this.#setLayer(layer, { ...current, terms: next, personal: { ...written, bytes } });
        }
        return { status: 'added' };
      }
    }).catch((error: unknown) => ({ status: 'failed' as const, message: messageOf(error) }));
  }

  #setLayer(layer: DictionaryLayer, data: LayerData): void {
    const before = this.#layers[layer];
    this.#layers = { ...this.#layers, [layer]: data };
    if (data.terms !== before.terms) {
      const { global, folder } = this.#layers;
      if (folder.terms.size === 0) this.#union = global.terms;
      else if (global.terms.size === 0) this.#union = folder.terms;
      else {
        const union = new Set(global.terms);
        for (const term of folder.terms) union.add(term);
        this.#union = union;
      }
    }
    if (data.warnings !== before.warnings) this.#notice(data.warnings);
    this.#snapshot = null;
    for (const listener of [...this.#listeners]) listener();
  }

  /**
   * D-R32-7 (r35b): os avisos de uma camada vão à área de avisos do app, cada camada e motivo uma
   * vez por sessão, num aviso só por carga da camada — o primeiro no texto, os outros (de qualquer
   * motivo ainda não avisado) no detalhe: a rajada de uma camada (arquivos, 16 arquivos/20 MiB,
   * termos) não tira os próprios avisos dos 3 visíveis (`MAX_NOTICES`). O aviso fica até a pessoa
   * fechar (D-R35B-02). Uma causa que some e volta não avisa de novo; a lista das Configurações
   * mostra os avisos de agora.
   */
  #notice(warnings: readonly DictionaryWarning[]): void {
    const keys = new Set<string>();
    const texts: string[] = [];
    for (const warning of warnings) {
      const key = `${warning.layer}:${warning.reason}`;
      if (this.#noticed.has(key)) continue;
      keys.add(key);
      // O texto do serviço vem em minúsculas (a lista o mostra como frase também).
      texts.push(warning.text.charAt(0).toLocaleUpperCase('pt-BR') + warning.text.slice(1));
    }
    const [text, ...more] = texts;
    if (text === undefined) return;
    for (const key of keys) this.#noticed.add(key);
    this.#deps.store.getState().pushNotice({
      kind: 'info',
      level: 'warn',
      notice: 'dictionary-limit',
      persistent: true,
      text,
      ...(more.length > 0 ? { detail: more.join(' ') } : {}),
    });
  }

  #view(data: LayerData): DictionaryLayerView {
    let view = this.#views.get(data);
    if (view === undefined) {
      view = {
        status: data.status,
        terms: [...data.terms],
        warnings: data.warnings,
        files: data.files,
      };
      this.#views.set(data, view);
    }
    return view;
  }
}
