import { VaultError, type VaultErrorCode } from '../errors';
import type { FsDirItem, FsPort, FsStat, WriteMode } from '../port';

/**
 * Porta de arquivos em memória (arch-backend §1.5.10) para Vitest e para o harness do Chromium
 * (D-6, R-2.12). É uma árvore POSIX sob `/vault`, com relógio lógico, ações externas que disparam
 * eventos de observação, injeção de falhas/atrasos e registro de chamadas. NUNCA entra no build de
 * produção: `scripts/assert-no-harness.mjs` procura os marcadores abaixo em `apps/desktop/dist`.
 */
export const MEMORY_FS_MARKER = '__SIMPLEMD_MEMORY_FS__';
export const MEMORY_FS_SENTINEL = 'simplemd:memory-provider';
export const MEMORY_ROOT = '/vault';

export type MemoryOp = 'pickDirectory' | 'readDir' | 'lstat' | 'readFile' | 'writeFile' | 'mkdirp';

export interface MemoryCall {
  readonly op: MemoryOp;
  readonly abs: string;
  readonly bytes?: Uint8Array;
  readonly mode?: WriteMode;
}

export interface MemoryFault {
  readonly op: MemoryOp;
  /** Erro a lançar (depois do atraso, se houver). */
  readonly error?: VaultErrorCode;
  readonly delayMs?: number;
  /** Remove a falha depois de aplicada uma vez (padrão: permanece até `clearFaults`). */
  readonly once?: boolean;
  /** Restringe a um caminho relativo ao vault. */
  readonly path?: string;
}

export interface MemoryFsOptions {
  /** Granularidade do mtime relatado (ex.: 2000 simula FAT); padrão 1. */
  readonly mtimeResolutionMs?: number;
  /** Relógio injetável; o padrão é lógico (+1 por mutação a partir de 1_700_000_000_000). */
  readonly now?: () => number;
}

export interface MemorySnapshot {
  readonly dirs: string[];
  readonly files: Array<[path: string, latin1: string]>;
}

type Node =
  | { kind: 'file'; bytes: Uint8Array; mtime: number }
  | { kind: 'dir'; mtime: number }
  | { kind: 'symlink'; target: string; mtime: number };

const encoder = new TextEncoder();
/** Decodificação byte a byte para asserções: o BOM, se houver, fica no texto. */
const decoder = new TextDecoder('utf-8', { ignoreBOM: true });

/** Bytes → string latin1 (um caractere por byte), em blocos para não estourar a pilha. */
function toLatin1(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 8192)
    out += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return out;
}

function toBytes(content: string | Uint8Array): Uint8Array {
  return typeof content === 'string' ? encoder.encode(content) : new Uint8Array(content);
}

function parentOf(abs: string): string {
  return abs.slice(0, abs.lastIndexOf('/')) || '/';
}

export class MemoryFsPort implements FsPort {
  readonly kind = MEMORY_FS_MARKER;
  readonly sentinel = MEMORY_FS_SENTINEL;
  readonly root = MEMORY_ROOT;
  readonly #nodes = new Map<string, Node>();
  readonly #children = new Map<string, Set<string>>();
  readonly #watchers = new Set<{ abs: string; onPaths: (paths: string[]) => void }>();
  readonly #resolution: number;
  readonly #now: () => number;
  #logical = 1_700_000_000_000;
  #calls: MemoryCall[] = [];
  #faults: MemoryFault[] = [];
  #pick: () => string | null | Promise<string | null> = () => MEMORY_ROOT;

  constructor(options: MemoryFsOptions = {}) {
    this.#resolution = options.mtimeResolutionMs ?? 1;
    this.#now = options.now ?? (() => ++this.#logical);
    this.#nodes.set('/', { kind: 'dir', mtime: 0 });
    this.#children.set('/', new Set());
    this.#mkdirs(MEMORY_ROOT);
  }

  // ---- FsPort -------------------------------------------------------------------------------

  async pickDirectory(): Promise<string | null> {
    await this.#enter('pickDirectory', MEMORY_ROOT);
    return this.#pick();
  }

  join(root: string, relPosix: string): string {
    return `${root.replace(/\/+$/, '')}/${relPosix}`;
  }

  async readDir(abs: string): Promise<FsDirItem[]> {
    await this.#enter('readDir', abs);
    const node = this.#nodes.get(abs);
    if (!node) throw new VaultError('NOT_FOUND', 'Pasta inexistente.', { path: abs });
    if (node.kind !== 'dir') throw new VaultError('INVALID_PATH', 'Não é pasta.', { path: abs });
    return [...(this.#children.get(abs) ?? [])].map((name) => ({
      name,
      kind: this.#nodes.get(this.join(abs, name))?.kind ?? 'other',
    }));
  }

  async lstat(abs: string): Promise<FsStat | null> {
    await this.#enter('lstat', abs);
    const node = this.#nodes.get(abs);
    if (!node) return null;
    return {
      kind: node.kind,
      size: node.kind === 'file' ? node.bytes.length : 0,
      mtime: node.mtime,
    };
  }

  async readFile(abs: string): Promise<Uint8Array> {
    await this.#enter('readFile', abs);
    const node = this.#nodes.get(this.#follow(abs));
    if (!node) throw new VaultError('NOT_FOUND', 'Arquivo inexistente.', { path: abs });
    if (node.kind !== 'file') throw new VaultError('INVALID_PATH', 'Não é arquivo.', { path: abs });
    return new Uint8Array(node.bytes);
  }

  async writeFile(abs: string, data: Uint8Array, mode: WriteMode): Promise<void> {
    await this.#enter('writeFile', abs, { bytes: new Uint8Array(data), mode });
    const target = this.#follow(abs);
    const existing = this.#nodes.get(target);
    if (existing && mode === 'create-new') {
      throw new VaultError('ALREADY_EXISTS', 'Arquivo já existe.', { path: abs });
    }
    if (existing && existing.kind !== 'file') {
      throw new VaultError('INVALID_PATH', 'Não é arquivo.', { path: abs });
    }
    if (this.#nodes.get(parentOf(target))?.kind !== 'dir') {
      throw new VaultError('NOT_FOUND', 'Pasta inexistente.', { path: abs });
    }
    this.#setFile(target, new Uint8Array(data));
  }

  async mkdirp(abs: string): Promise<void> {
    await this.#enter('mkdirp', abs);
    this.#mkdirs(abs);
  }

  async watch(abs: string, onPaths: (paths: string[]) => void): Promise<() => void> {
    const watcher = { abs, onPaths };
    this.#watchers.add(watcher);
    return () => this.#watchers.delete(watcher);
  }

  // ---- Controles de teste ---------------------------------------------------------------------

  /** Define o resultado do diálogo de pasta (`null` = cancelado). */
  setPickDirectory(pick: () => string | null | Promise<string | null>): void {
    this.#pick = pick;
  }

  /** Cria arquivos (e pastas intermediárias) relativos ao vault, sem registrar chamadas. */
  seed(files: Record<string, string | Uint8Array>): void {
    for (const [rel, content] of Object.entries(files)) {
      const abs = this.join(MEMORY_ROOT, rel);
      this.#mkdirs(parentOf(abs));
      this.#setFile(abs, toBytes(content));
    }
  }

  /** Cria uma pasta vazia relativa ao vault. */
  seedDir(rel: string): void {
    this.#mkdirs(this.join(MEMORY_ROOT, rel));
  }

  /** Escrita feita por outro programa: muda bytes e mtime e dispara a observação. */
  externalWrite(rel: string, content: string | Uint8Array): void {
    const abs = this.join(MEMORY_ROOT, rel);
    this.#mkdirs(parentOf(abs));
    this.#setFile(abs, toBytes(content));
    this.#emit(abs);
  }

  /** Muda só o mtime (ex.: iCloud tocando metadados; R-2.6). */
  touch(rel: string): void {
    const abs = this.join(MEMORY_ROOT, rel);
    const node = this.#nodes.get(abs);
    if (!node) throw new VaultError('NOT_FOUND', 'Arquivo inexistente.', { path: rel });
    node.mtime = this.#tick();
    this.#emit(abs);
  }

  /** Remoção externa (arquivo ou pasta inteira). Renomear = `remove` + `externalWrite`. */
  remove(rel: string): void {
    const abs = this.join(MEMORY_ROOT, rel);
    if (!this.#nodes.has(abs)) return;
    for (const key of [...this.#nodes.keys()]) {
      if (key === abs || key.startsWith(`${abs}/`)) {
        this.#nodes.delete(key);
        this.#children.delete(key);
      }
    }
    this.#children.get(parentOf(abs))?.delete(abs.slice(abs.lastIndexOf('/') + 1));
    this.#emit(abs);
  }

  /** Cria um link simbólico em `rel` apontando para `target` (caminho absoluto da árvore). */
  symlink(rel: string, target: string): void {
    const abs = this.join(MEMORY_ROOT, rel);
    this.#mkdirs(parentOf(abs));
    this.#link(abs, { kind: 'symlink', target, mtime: this.#tick() });
  }

  fault(fault: MemoryFault): void {
    this.#faults.push(fault);
  }

  failNext(op: MemoryOp, error: VaultErrorCode, path?: string): void {
    this.#faults.push(
      path === undefined ? { op, error, once: true } : { op, error, once: true, path },
    );
  }

  clearFaults(): void {
    this.#faults = [];
  }

  calls(): readonly MemoryCall[] {
    return this.#calls;
  }

  resetCalls(): void {
    this.#calls = [];
  }

  /** Bytes atuais de um arquivo relativo ao vault, ou `null`. */
  readBytes(rel: string): Uint8Array | null {
    const node = this.#nodes.get(this.join(MEMORY_ROOT, rel));
    return node?.kind === 'file' ? new Uint8Array(node.bytes) : null;
  }

  readText(rel: string): string | null {
    const bytes = this.readBytes(rel);
    return bytes === null ? null : decoder.decode(bytes);
  }

  /** Estado serializável (pastas e arquivos) para o `&persist=1` do harness. */
  snapshot(): MemorySnapshot {
    const dirs: string[] = [];
    const files: Array<[string, string]> = [];
    const prefix = `${MEMORY_ROOT}/`;
    for (const [abs, node] of this.#nodes) {
      if (!abs.startsWith(prefix)) continue;
      const rel = abs.slice(prefix.length);
      if (node.kind === 'dir') dirs.push(rel);
      else if (node.kind === 'file') files.push([rel, toLatin1(node.bytes)]);
    }
    return { dirs, files };
  }

  restore(snapshot: MemorySnapshot): void {
    for (const rel of snapshot.dirs) this.seedDir(rel);
    this.seed(
      Object.fromEntries(
        snapshot.files.map(([rel, latin1]) => [
          rel,
          Uint8Array.from(latin1, (c) => c.charCodeAt(0)),
        ]),
      ),
    );
  }

  // ---- Internos -------------------------------------------------------------------------------

  #tick(): number {
    const now = this.#now();
    return Math.floor(now / this.#resolution) * this.#resolution;
  }

  async #enter(op: MemoryOp, abs: string, extra: Partial<MemoryCall> = {}): Promise<void> {
    this.#calls.push({ op, abs, ...extra });
    const fault = this.#faults.find(
      (f) => f.op === op && (f.path === undefined || this.join(MEMORY_ROOT, f.path) === abs),
    );
    if (!fault) return;
    if (fault.once) this.#faults.splice(this.#faults.indexOf(fault), 1);
    if (fault.delayMs) await new Promise<void>((resolve) => setTimeout(resolve, fault.delayMs));
    if (fault.error)
      throw new VaultError(fault.error, `Falha injetada (${fault.error}).`, { path: abs });
  }

  #follow(abs: string): string {
    let current = abs;
    for (let hops = 0; hops < 8; hops++) {
      const node = this.#nodes.get(current);
      if (node?.kind !== 'symlink') return current;
      current = node.target;
    }
    return current;
  }

  #link(abs: string, node: Node): void {
    this.#nodes.set(abs, node);
    this.#children.get(parentOf(abs))?.add(abs.slice(abs.lastIndexOf('/') + 1));
    if (node.kind === 'dir' && !this.#children.has(abs)) this.#children.set(abs, new Set());
  }

  #setFile(abs: string, bytes: Uint8Array): void {
    this.#link(abs, { kind: 'file', bytes, mtime: this.#tick() });
  }

  #mkdirs(abs: string): void {
    const parts = abs.split('/').filter(Boolean);
    let current = '';
    for (const part of parts) {
      current = `${current}/${part}`;
      const node = this.#nodes.get(current);
      if (node === undefined) this.#link(current, { kind: 'dir', mtime: this.#tick() });
      else if (node.kind !== 'dir') {
        throw new VaultError('INVALID_PATH', 'Componente não é pasta.', { path: current });
      }
    }
  }

  #emit(abs: string): void {
    for (const watcher of this.#watchers) {
      if (abs === watcher.abs || abs.startsWith(`${watcher.abs}/`)) watcher.onPaths([abs]);
    }
  }
}
