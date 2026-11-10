import { VaultError } from './errors';
import { toVaultPath } from './path';
import type {
  FsDirItem,
  FsSearchOptions,
  TextSearchHit,
  TextSearchNote,
  TextSearchSkipped,
  TextSearchSummary,
} from './port';

/**
 * Busca no texto das notas (r37, design-r37 §1; D-R37-1..3): o motor das portas Node e de memória,
 * com as regras que o Rust (`vault/search.rs`, r37b) repete e que a fixture compartilhada
 * `test/fixtures/search-fold.json` confere nos dois lados. Sem índice: o texto só passa pela
 * memória durante a busca, nada é gravado.
 *
 * - Dobra por ponto de código (`foldForSearch`); casamento literal dentro de cada linha, sem regex
 *   e sem colapsar espaços (D-R37-3).
 * - Posição em coordenadas do editor e trechos de 40/80 unidades (`TextSearchHit`).
 * - Percurso (`searchTree`) sem seguir links, sem ocultos nem notas só na nuvem, até 64 níveis de
 *   pasta, 2 MiB por nota, 5 trechos e até 999 casamentos contados por nota, `limit` notas,
 *   cancelamento.
 */

/** Consulta: até 256 pontos de código como digitada e, dobrada, ao menos 2. */
export const SEARCH_QUERY_MIN = 2;
export const SEARCH_QUERY_MAX = 256;
/** Teto por nota: 2 MiB passa; 2 MiB + 1 → `tooLarge`, sem ler o conteúdo. */
export const SEARCH_NOTE_MAX_BYTES = 2 * 1024 * 1024;
/** Trechos por nota e teto da contagem de casamentos de uma nota. */
export const SEARCH_HITS_PER_NOTE = 5;
export const SEARCH_TOTAL_MAX = 999;
/** Notas com resultado antes de parar (`truncated`): padrão e máximo (design-r37 §1). */
export const SEARCH_LIMIT_DEFAULT = 200;
export const SEARCH_LIMIT_MAX = 500;

/** Contexto do trecho em unidades UTF-16 e quanto do casamento entra nele. */
const CONTEXT_BEFORE = 40;
const CONTEXT_AFTER = 80;
const SNIPPET_MATCH_MAX = 256;
/** Lotes de até 16 notas ou 50 ms; progresso a cada 200 notas; 8 leituras adiantadas. */
const BATCH_NOTES = 16;
const BATCH_MS = 50;
const PROGRESS_EVERY = 200;
const PARALLEL_READS = 8;
/**
 * Níveis de pasta abaixo da raiz que o percurso lista; a pasta mais funda conta `unreadable`. O
 * teto do Rust (AppSec r37b item 1, um descritor por nível), aqui pela paridade entre as portas.
 */
const DEPTH_MAX = 64;

/** Quebras do editor (`codec.ts`): CRLF, CR e LF valem uma cada. */
const LINE_BREAK = /\r\n?|\n/;
const MD_NAME = /\.md$/i;
const MARKS = /\p{M}/gu;
/** Metade de par substituto sem a outra (UTF-16 mal formado). */
const LONE_SURROGATE = /\p{Cs}/u;
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** Dobra dos pontos de código fora do ASCII já vistos; zera ao passar de 8.192 (texto hostil). */
const folds = new Map<number, string>();
const FOLDS_MAX = 8192;

function foldCodePoint(cp: number): string {
  let folded = folds.get(cp);
  if (folded === undefined) {
    folded = String.fromCodePoint(cp).normalize('NFD').replace(MARKS, '').toLowerCase();
    if (folds.size >= FOLDS_MAX) folds.clear();
    folds.set(cp, folded);
  }
  return folded;
}

/**
 * Dobra de busca: cada ponto de código vira NFD, sem as marcas (`\p{M}`), em minúsculas — o
 * mapeamento sem contexto (`Σ` → `σ` sempre; `İ` → `i`; `ß`, `ø` e `ς` ficam). Ponto a ponto, como
 * no Rust, para a posição voltar ao original; uma marca solta some.
 */
export function foldForSearch(text: string): string {
  let out = '';
  let ascii = 0; // início do trecho ASCII ainda não copiado
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) < 0x80) continue;
    const cp = text.codePointAt(i) ?? 0;
    out += text.slice(ascii, i).toLowerCase() + foldCodePoint(cp);
    if (cp > 0xffff) i++;
    ascii = i + 1;
  }
  return ascii === 0 ? text.toLowerCase() : out + text.slice(ascii).toLowerCase();
}

/** Pontos de código de `text`, contados até `stop`. */
function codePoints(text: string, stop: number): number {
  let count = 0;
  for (let i = 0; i < text.length && count < stop; i++) {
    const unit = text.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) i++;
    }
    count++;
  }
  return count;
}

/**
 * Consulta aceita pela busca: `long` acima de 256 pontos de código como digitada (conferido
 * primeiro); `short` com um substituto solto (nunca casa com texto decodificado, e o IPC do Rust o
 * recusa ao ler o JSON; AppSec r37a item 4) ou com menos de 2 pontos de código depois da dobra
 * (`a`, `á` em NFD, só marcas); senão `ok`. Espaços contam (D-R37-3).
 */
export function checkSearchQuery(query: string): 'ok' | 'short' | 'long' {
  if (codePoints(query, SEARCH_QUERY_MAX + 1) > SEARCH_QUERY_MAX) return 'long';
  if (LONE_SURROGATE.test(query)) return 'short';
  return codePoints(foldForSearch(query), SEARCH_QUERY_MIN) < SEARCH_QUERY_MIN ? 'short' : 'ok';
}

/** `limit` da busca: padrão 200; senão inteiro entre 1 e 500. */
export function searchLimit(limit?: number): number {
  if (limit === undefined || !Number.isFinite(limit)) return SEARCH_LIMIT_DEFAULT;
  return Math.min(SEARCH_LIMIT_MAX, Math.max(1, Math.floor(limit)));
}

/**
 * Para cada unidade da dobra de `line`, onde começa (em `line`) o ponto de código que a gerou; em
 * `foldedLength`, `line.length`. Um casamento alinhado da dobra `[a, b)` é `[origin[a], origin[b])`.
 */
function originOf(line: string, foldedLength: number): Int32Array {
  const origin = new Int32Array(foldedLength + 1);
  let j = 0;
  for (let i = 0; i < line.length;) {
    const cp = line.codePointAt(i) ?? 0;
    const units = cp < 0x80 ? 1 : foldCodePoint(cp).length;
    origin.fill(i, j, j + units);
    j += units;
    i += cp > 0xffff ? 2 : 1;
  }
  origin[j] = line.length;
  return origin;
}

/** `i` cai entre as duas metades de um par substituto. */
function splitsPair(text: string, i: number): boolean {
  const low = text.charCodeAt(i);
  const high = text.charCodeAt(i - 1);
  return low >= 0xdc00 && low <= 0xdfff && high >= 0xd800 && high <= 0xdbff;
}

/** Trecho de `[start, end)` na linha: 40 unidades antes, 80 depois (até 256 do casamento). */
function hitAt(line: string, lineNo: number, start: number, end: number): TextSearchHit {
  let from = Math.max(0, start - CONTEXT_BEFORE);
  if (splitsPair(line, from)) from++;
  let to = Math.min(line.length, start + Math.min(end - start, SNIPPET_MATCH_MAX) + CONTEXT_AFTER);
  if (splitsPair(line, to)) to--;
  return {
    line: lineNo,
    col: start,
    len: end - start,
    text: line.slice(from, to),
    at: start - from,
    cutBefore: from > 0,
    cutAfter: to < line.length,
  };
}

type NoteMatches = Pick<TextSearchNote, 'total' | 'hits'>;

/** Casamentos da consulta já dobrada (`folded`) no texto decodificado de uma nota. */
function matchNote(text: string, folded: string): NoteMatches | null {
  const body = text.startsWith('\uFEFF') ? text.slice(1) : text;
  // Corte rápido: a dobra é ponto a ponto, então todo casamento de uma linha está na da nota.
  if (folded === '' || !foldForSearch(body).includes(folded)) return null;
  const hits: TextSearchHit[] = [];
  let total = 0;
  const lines = body.split(LINE_BREAK);
  for (let n = 0; n < lines.length && total < SEARCH_TOTAL_MAX; n++) {
    const line = lines[n] ?? '';
    const lineFold = foldForSearch(line);
    let at = lineFold.indexOf(folded);
    if (at < 0) continue;
    const origin = originOf(line, lineFold.length);
    while (at >= 0 && total < SEARCH_TOTAL_MAX) {
      const end = at + folded.length;
      // Começo ou fim dentro da dobra de um ponto de código ("하" em "한"): não é casamento; a
      // procura recomeça na unidade seguinte (não depois dele).
      const inside =
        (at > 0 && origin[at] === origin[at - 1]) ||
        (end < lineFold.length && origin[end] === origin[end - 1]);
      if (inside) {
        at = lineFold.indexOf(folded, at + 1);
        continue;
      }
      total++;
      if (hits.length < SEARCH_HITS_PER_NOTE) {
        hits.push(hitAt(line, n, origin[at] ?? 0, origin[end] ?? line.length));
      }
      at = lineFold.indexOf(folded, end);
    }
  }
  return total === 0 ? null : { total, hits };
}

/**
 * Casamentos de `query` numa nota já decodificada (com BOM e CR/CRLF, como no disco), pelas regras
 * da busca no vault: até 5 trechos e o total contado até 999; `null` sem casamento.
 */
export function searchNote(text: string, query: string): NoteMatches | null {
  return matchNote(text, foldForSearch(query));
}

/** O caminho passa pela guarda do vault como está (`toVaultPath`; nome reservado, `:` etc. não). */
function isGuarded(rel: string): boolean {
  try {
    return toVaultPath(rel) === rel;
  } catch {
    return false;
  }
}

/** Caminho que a busca devolve: nota `.md` aceita pela guarda, sem segmento oculto. */
export function isSearchPath(rel: string): boolean {
  return MD_NAME.test(rel) && !rel.split('/').some((s) => s.startsWith('.')) && isGuarded(rel);
}

/** Unidade UTF-16 na ordem dos pontos de código: as de par (D800–DFFF) vão depois de E000–FFFF. */
function rank(unit: number): number {
  if (unit < 0xd800) return unit;
  return unit < 0xe000 ? unit + 0x2000 : unit - 0x800;
}

/** Ordem do percurso: nome pela ordem dos pontos de código (a dos bytes UTF-8, a de `str` no Rust). */
function byName(a: FsDirItem, b: FsDirItem): number {
  const length = Math.min(a.name.length, b.name.length);
  for (let i = 0; i < length; i++) {
    const x = a.name.charCodeAt(i);
    const y = b.name.charCodeAt(i);
    if (x !== y) return rank(x) - rank(y);
  }
  return a.name.length - b.name.length;
}

/**
 * Um item da listagem, nesta ordem: oculto (sem descer) → link ou junção (nunca seguido) → pasta
 * aceita pela guarda → nota `.md` aceita pela guarda, só na nuvem ou não. O resto (outros
 * arquivos, nomes que a guarda recusa) fica de fora sem contar.
 */
function classify(
  item: FsDirItem,
  rel: string,
): 'hidden' | 'links' | 'dir' | 'cloud' | 'note' | null {
  if (item.name.startsWith('.')) return 'hidden';
  if (item.kind === 'symlink') return 'links';
  if (item.kind === 'dir') return isGuarded(rel) ? 'dir' : null;
  if (item.kind !== 'file' || !MD_NAME.test(item.name) || !isGuarded(rel)) return null;
  return item.cloudOnly ? 'cloud' : 'note';
}

/** Leitura de uma nota pela porta: os bytes ou por que não vieram. */
export type SearchRead = Uint8Array | 'links' | 'tooLarge' | 'unreadable';

/** O que o percurso pede a uma porta. Caminhos relativos POSIX; `''` é a raiz. */
export interface SearchSource {
  /** Itens da pasta sem seguir links (`kind: 'symlink'`), com o `cloudOnly` da listagem. */
  readDir(rel: string): Promise<readonly FsDirItem[]>;
  /** A nota aberta sem seguir link, com no máximo `maxBytes` bytes. Rejeitar vale `unreadable`. */
  readNote(rel: string, maxBytes: number): Promise<SearchRead>;
}

type SkippedCounts = { -readonly [K in keyof TextSearchSkipped]: number };

/**
 * Percorre a árvore de `source` em profundidade — em cada pasta, as notas e depois as subpastas,
 * pela ordem de `byName` — com até 8 leituras adiantadas e os resultados na ordem do percurso.
 *
 * - Lotes de até 16 notas ou 50 ms em `onNotes`: o envio por tempo vence também enquanto o
 *   percurso espera uma leitura ou listagem lenta (nuvem, rede; code review r37a item 3).
 *   `onProgress` a cada 200 notas examinadas.
 * - Achar a nota `limit + 1` prova que havia mais: ela não sai, `truncated` e para.
 * - O `signal` é conferido antes de cada pasta, de cada arquivo e de cada lote: abortado, o lote
 *   pendente é descartado, nada mais sai e o resumo volta com `cancelled`.
 * - Depois de truncar ou cancelar, as leituras já pedidas terminam antes de a busca voltar: nenhum
 *   descritor nem buffer fica para trás (code review r37a item 4; AppSec r37a item 3).
 * - Consulta fora de `checkSearchQuery` → `INVALID_QUERY` (como o comando do Rust). Falha ao listar
 *   a raiz rejeita; uma subpasta ilegível, ou a mais de 64 níveis da raiz, conta como `unreadable`.
 */
export async function searchTree(
  source: SearchSource,
  options: FsSearchOptions,
): Promise<TextSearchSummary> {
  if (checkSearchQuery(options.query) !== 'ok') {
    throw new VaultError('INVALID_QUERY', 'Consulta de busca inválida.');
  }
  const folded = foldForSearch(options.query);
  const limit = searchLimit(options.limit);
  const { signal, onNotes, onProgress } = options;
  const skipped: SkippedCounts = {
    hidden: 0,
    links: 0,
    cloud: 0,
    tooLarge: 0,
    notUtf8: 0,
    unreadable: 0,
  };
  const queue: Array<{ readonly rel: string; readonly read: Promise<SearchRead> }> = [];
  let batch: TextSearchNote[] = [];
  let flushedAt = performance.now();
  /** Desmarca o envio por tempo do lote pendente, marcado quando ele recebe a primeira nota. */
  let unmark: (() => void) | undefined;
  let scanned = 0;
  let matched = 0;
  let truncated = false;
  let cancelled = false;
  let stopped = false;

  const unschedule = () => {
    unmark?.();
    unmark = undefined;
  };
  const cancel = () => {
    cancelled = true;
    stopped = true;
    batch = [];
    unschedule();
  };
  const flush = () => {
    unschedule();
    if (batch.length === 0) return;
    if (signal.aborted) return cancel();
    const notes = batch;
    batch = [];
    matched += notes.length;
    flushedAt = performance.now();
    onNotes(notes);
  };
  /** O lote sai 50 ms depois do envio anterior, mesmo com o percurso parado no disco. */
  const schedule = () => {
    if (unmark !== undefined || batch.length === 0) return;
    const wait = Math.max(0, BATCH_MS - (performance.now() - flushedAt));
    const handle = setTimeout(() => {
      unmark = undefined;
      flush();
    }, wait);
    unmark = () => clearTimeout(handle);
  };
  const examine = (rel: string, read: SearchRead) => {
    scanned++;
    if (typeof read === 'string') skipped[read]++;
    else if (read.length > SEARCH_NOTE_MAX_BYTES) skipped.tooLarge++;
    else {
      let text: string | null = null;
      try {
        text = decoder.decode(read);
      } catch {
        skipped.notUtf8++;
      }
      const found = text === null ? null : matchNote(text, folded);
      if (found !== null) {
        if (matched + batch.length >= limit) {
          truncated = true;
          stopped = true;
          return;
        }
        batch.push({ path: rel, ...found });
      }
    }
    if (scanned % PROGRESS_EVERY === 0) onProgress?.(scanned);
    const due = batch.length > 0 && performance.now() - flushedAt >= BATCH_MS;
    if (batch.length >= BATCH_NOTES || due) flush();
    else schedule();
  };
  /** Examina as leituras da fila, na ordem, até sobrarem `keep`. */
  const drain = async (keep: number) => {
    while (queue.length > keep && !stopped) {
      const next = queue.shift();
      if (next === undefined) return;
      const read = await next.read;
      if (signal.aborted) return cancel();
      examine(next.rel, read);
    }
  };

  try {
    // Pastas por visitar e quantos níveis cada uma está abaixo da raiz.
    const dirs: Array<readonly [rel: string, depth: number]> = [['', 0]];
    while (dirs.length > 0 && !stopped) {
      const [dir, depth] = dirs.pop() ?? (['', 0] as const);
      if (signal.aborted) {
        cancel();
        break;
      }
      // Funda demais: conta sem listar, depois das leituras já pedidas (a ordem do Rust).
      if (depth > DEPTH_MAX) {
        await drain(0);
        if (!stopped) skipped.unreadable++;
        continue;
      }
      // A listagem começa já e, enquanto não chega, as leituras da pasta anterior são examinadas:
      // a nota achada nelas sai em 50 ms mesmo com uma listagem lenta (code review r37a item 3).
      const listing = source.readDir(dir).then(
        (items) => ({ items }),
        (error: unknown) => ({ error }),
      );
      await drain(0);
      const listed = await listing;
      if (stopped) break;
      if ('error' in listed) {
        if (dir === '') throw listed.error;
        skipped.unreadable++;
        continue;
      }
      const { items } = listed;
      const subdirs: string[] = [];
      for (const item of [...items].sort(byName)) {
        const rel = dir === '' ? item.name : `${dir}/${item.name}`;
        const kind = classify(item, rel);
        if (kind === 'dir') subdirs.push(rel);
        else if (kind === 'note') {
          if (signal.aborted) {
            cancel();
            break;
          }
          const read = source
            .readNote(rel, SEARCH_NOTE_MAX_BYTES)
            .catch(() => 'unreadable' as const);
          queue.push({ rel, read });
          await drain(PARALLEL_READS - 1);
          if (stopped) break;
        } else if (kind !== null) skipped[kind]++;
      }
      dirs.push(...subdirs.reverse().map((rel) => [rel, depth + 1] as const));
    }
    await drain(0);
    // Truncada ou cancelada: as leituras ainda na fila (nunca rejeitam) terminam antes da volta.
    await Promise.all(queue.map((entry) => entry.read));
    if (!cancelled) flush();
  } finally {
    unschedule();
  }
  return { scanned, matched, truncated, cancelled, skipped };
}
