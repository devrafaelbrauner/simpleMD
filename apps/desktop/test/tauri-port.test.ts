// Contrato da porta de produção (TauriFsPort + plataforma Tauri) contra um gateway Rust emulado
// (arch-backend r2 §1.2, V-P6; fecha TA-3). O emulador segue os comandos `vault_*`,
// `save_target_*` e `open_file_pick` sobre pastas reais em /tmp, e os `dict_global_*` (r32a) e
// `dict_import`/`dict_manage` da camada global (r33a) pelo falso do harness, que tem a semântica do
// Rust; r35a: os `spell_*` também, pelo corretor falso (o token da recarga conferido aqui). A
// política nativa em si (classes, links, tetos, troca de pasta, camada global de dicionários,
// importação, corretor) é provada pelos testes Rust (`cargo test`).
import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, sep as nativeSep } from 'node:path';
import { LocalFsProvider, VaultError, imageKindOf, sniffImage } from '@simplemd/vault';
import { afterAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { createHarnessDictionaries } from '../harness/dictionaries';
import { createHarnessSpell, HARNESS_MISSPELLINGS } from '../harness/spell';
import { createAppController } from '../src/app/controller';
import { TauriFsPort } from '../src/platform/tauri/fsPort';
import { createTauriPlatform } from '../src/platform/tauri/platform';
import { recordingRoot } from './helpers';

type Options = { headers?: Record<string, string> };
interface GatewayError {
  code: string;
  message: string;
  detail?: unknown;
}

const ipc = vi.hoisted(() => ({
  sep: '/',
  calls: [] as Array<{ cmd: string; args: unknown; headers?: Record<string, string> }>,
  handler: null as null | ((cmd: string, args: unknown, options?: Options) => unknown),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: async (cmd: string, args?: unknown, options?: Options) => {
    ipc.calls.push({ cmd, args, ...(options?.headers ? { headers: options.headers } : {}) });
    if (!ipc.handler) throw new Error('sem gateway');
    return ipc.handler(cmd, args, options);
  },
  Channel: class<T> {
    onmessage: (message: T) => void = () => {};
  },
}));
vi.mock('@tauri-apps/api/path', () => ({ sep: () => ipc.sep }));
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ onCloseRequested: async () => () => {}, destroy: async () => {} }),
}));
// O sha256 puro-JS (@noble/hashes) do falso `dict_global_*` fica ~12× mais lento sob a cobertura v8
// do CI: os 2 hashes de 7 MiB de "tetos da camada" levavam 3,8 s no Linux (r32d). Mesmo digest,
// calculado em C++ pelo Node; o mock do módulo do hash alcança o `@simplemd/vault` e o provider.
vi.mock('../../../packages/vault/src/hash', () => ({
  sha256Hex: (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex'),
}));

const CAPABILITY = JSON.parse(
  fs.readFileSync(join(__dirname, '../src-tauri/capabilities/main-window.json'), 'utf8'),
) as { permissions: string[] };

const roots: string[] = [];
afterAll(() => roots.forEach((r) => fs.rmSync(r, { recursive: true, force: true })));
function tempDir(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'simplemd-port-')));
  roots.push(dir);
  return dir;
}

const fail = (code: string, detail?: unknown): GatewayError => ({
  code,
  message: 'falha',
  ...(detail === undefined ? {} : { detail }),
});

const sha = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');

/**
 * Gateway emulado: uma pasta ativa por vez, token novo a cada `pick_vault`. Como o Rust (CR2-02),
 * a pasta escolhida fica pendente e só vira a ativa no primeiro uso do token dela.
 */
class FakeGateway {
  pick: string | null = null;
  active: { root: string; token: number } | null = null;
  pending: { root: string; token: number } | null = null;
  savePick: string | null = null;
  openPick: string | null = null;
  readonly targets = new Map<string, string>();
  readonly failNext = new Map<string, GatewayError | string>();
  watchChannel: { onmessage: (m: unknown) => void } | null = null;
  /** r32a: a camada global de dicionários "deste computador" (semântica de `vault::dictionaries`). */
  readonly dictionaries = createHarnessDictionaries();
  /** r33a: o que `dict_import` devolve na camada da pasta (o token é conferido como no Rust). */
  folderImport: unknown = null;
  /** r35a: o corretor da r34 pelo falso (as regras do `spell/mod.rs`; "excessão" é o erro). */
  readonly spell = createHarnessSpell({ misspellings: HARNESS_MISSPELLINGS });
  #token = 0;

  #root(token: unknown): string {
    if (this.pending?.token === token) {
      this.active = this.pending;
      this.pending = null;
    }
    if (!this.active) throw fail('NO_VAULT');
    if (token !== this.active.token) throw fail('VAULT_CLOSED');
    return this.active.root;
  }

  #path(token: unknown, rel: string): string {
    const root = this.#root(token);
    if (rel.split('/').some((s) => s === '..')) throw fail('OUTSIDE_VAULT');
    // r7 §1.13: como `validate_rel`, os dois `.markdownlint.json(c)` passam só como segmento único.
    const rootConfig = rel === '.markdownlint.json' || rel === '.markdownlint.jsonc';
    const hidden = rel
      .split('/')
      .some((s, i) => s.startsWith('.') && !(i === 0 && s === '.simplemd'));
    if (hidden && !rootConfig) throw fail('PERMISSION_DENIED');
    return rel === '' ? root : join(root, ...rel.split('/'));
  }

  #io<T>(op: () => T): T {
    try {
      return op();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      throw fail(
        code === 'ENOENT'
          ? 'NOT_FOUND'
          : code === 'EEXIST'
            ? 'ALREADY_EXISTS'
            : code === 'EACCES'
              ? 'PERMISSION_DENIED'
              : 'IO',
      );
    }
  }

  handler = (cmd: string, raw: unknown, options?: Options): unknown => {
    const injected = this.failNext.get(cmd);
    if (injected !== undefined) {
      this.failNext.delete(cmd);
      throw injected;
    }
    const a = (raw ?? {}) as Record<string, unknown>;
    const h = options?.headers ?? {};
    switch (cmd) {
      case 'pick_vault':
        if (this.pick === null) return null;
        this.pending = { root: this.pick, token: ++this.#token };
        this.targets.clear();
        return { ...this.pending };
      case 'vault_lstat': {
        const p = this.#path(a.token, String(a.rel));
        if (!fs.existsSync(p)) return null;
        const st = fs.lstatSync(p);
        return {
          kind: st.isSymbolicLink() ? 'symlink' : st.isDirectory() ? 'dir' : 'file',
          size: st.size,
          mtime: Math.trunc(st.mtimeMs),
        };
      }
      case 'vault_read_dir': {
        const p = this.#path(a.token, String(a.rel));
        return this.#io(() =>
          fs.readdirSync(p, { withFileTypes: true }).map((d) => ({
            name: d.name,
            kind: d.isSymbolicLink() ? 'symlink' : d.isDirectory() ? 'dir' : 'file',
            size: 0,
            mtime: 0,
          })),
        );
      }
      case 'vault_read_file': {
        const p = this.#path(a.token, String(a.rel));
        const buf = this.#io(() => fs.readFileSync(p));
        return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      }
      case 'vault_write_file': {
        const p = this.#path(
          Number(h['x-simplemd-token']),
          decodeURIComponent(h['x-simplemd-rel']!),
        );
        const mode = h['x-simplemd-mode'];
        const expected = h['x-simplemd-expected-sha256'];
        if (mode === 'create-new' && expected === undefined) {
          this.#io(() => fs.writeFileSync(p, raw as Uint8Array, { flag: 'wx' }));
          return null;
        }
        if (mode !== 'overwrite' || !/^[0-9a-f]{64}$/.test(expected ?? '')) {
          throw fail('INVALID_PATH');
        }
        // Como `vault::replace` (r26): confere o sha256 atual e troca por temporário + rename.
        const current = this.#io(() => fs.readFileSync(p));
        if (createHash('sha256').update(current).digest('hex') !== expected) {
          throw fail('CONFLICT');
        }
        if (current.equals(raw as Uint8Array)) return null;
        const temp = join(dirname(p), `.~simplemd-${randomBytes(8).toString('hex')}.tmp`);
        fs.writeFileSync(temp, raw as Uint8Array, { flag: 'wx' });
        fs.renameSync(temp, p);
        return null;
      }
      case 'vault_mkdir': {
        const p = this.#path(a.token, String(a.rel));
        this.#io(() => fs.mkdirSync(p, { recursive: true }));
        return null;
      }
      case 'vault_watch':
        this.#root(a.token);
        this.watchChannel = a.onEvent as { onmessage: (m: unknown) => void };
        return 7;
      case 'vault_unwatch':
      case 'app_mark':
        return null;
      case 'save_target_pick': {
        if (this.savePick === null) return null;
        const token = `t${this.targets.size + 1}`;
        this.targets.set(token, this.savePick);
        return { token, fileName: basename(this.savePick) };
      }
      case 'save_target_write': {
        const path = this.targets.get(h['x-simplemd-save-token'] ?? '');
        if (path === undefined) throw fail('TOKEN_INVALID');
        this.targets.delete(h['x-simplemd-save-token']!);
        fs.writeFileSync(path, raw as Uint8Array);
        return null;
      }
      case 'open_file_pick': {
        if (this.openPick === null) return null;
        const size = fs.statSync(this.openPick).size;
        const fileName = basename(this.openPick);
        if (size > Number(a.maxBytes)) throw fail('TOO_LARGE', { fileName, size });
        return { fileName, bytes: [...fs.readFileSync(this.openPick)] };
      }
      // r7 §1.3: como `vault::image::read_image` (tipo pela extensão + bytes mágicos no Rust).
      case 'vault_read_image': {
        const rel = String(a.rel);
        const p = this.#path(a.token, rel);
        const kind = imageKindOf(rel);
        if (kind === null) throw fail('UNSUPPORTED_IMAGE');
        const buf = this.#io(() => fs.readFileSync(p));
        if (!sniffImage(kind, buf)) throw fail('UNSUPPORTED_IMAGE');
        return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      }
      case 'open_url':
        return null;
      case 'lt_languages':
        return '[{"longCode":"pt-BR"}]';
      case 'lt_check':
        return '{"matches":[]}';
      case 'lt_cancel':
        return null;
      case 'dict_global_read':
        return this.dictionaries.dictionaries.readGlobal();
      case 'dict_global_write':
        return this.dictionaries.dictionaries.writeGlobal(
          String(a.name),
          String(a.text),
          a.expectedSha256 === null ? null : String(a.expectedSha256),
        );
      // r33a: a camada global pelo falso (as regras do `import.rs`); a da pasta só confere o token
      // (a gravação em `.simplemd/dictionaries` é provada pelos testes Rust).
      case 'dict_import':
        if (a.layer === 'folder') {
          this.#root(a.token);
          return this.folderImport;
        }
        return this.dictionaries.dictionaries.import('global');
      case 'dict_manage': {
        if (a.layer === 'folder') {
          this.#root(a.token);
          return null;
        }
        const fake = this.dictionaries.dictionaries;
        const action = a.action as 'remove' | { rename: { to: string } };
        return action === 'remove'
          ? fake.remove('global', String(a.name))
          : fake.rename('global', String(a.name), action.rename.to);
      }
      // r35a: o token da recarga resolve a pasta como o `VaultState::root` (a pendente vira a ativa).
      case 'spell_check':
        return this.spell.spell.check(String(a.lang), a.words as string[]);
      case 'spell_suggest':
        return this.spell.spell.suggest(String(a.lang), String(a.word));
      case 'spell_reload':
        if ('token' in a) this.#root(a.token);
        return this.spell.spell.reload('token' in a ? 'folder' : 'global');
      default:
        throw `comando ${cmd} não permitido pela ACL`;
    }
  };
}

let gateway: FakeGateway;
beforeEach(() => {
  gateway = new FakeGateway();
  ipc.handler = gateway.handler;
  ipc.calls.length = 0;
  ipc.sep = nativeSep; // as pastas temporárias são reais: o separador do SO que roda o teste
});

async function openVault(root = tempDir()) {
  gateway.pick = root;
  const port = new TauriFsPort();
  const provider = new LocalFsProvider(port);
  const handle = await provider.open();
  return { root, port, provider, handle };
}

const codeOf = (p: Promise<unknown>) =>
  p.then(
    (value) => `OK(${JSON.stringify(value)})`,
    (error: unknown) => (error instanceof VaultError ? error.code : `RAW ${String(error)}`),
  );

describe('TauriFsPort sobre o gateway do vault', () => {
  test('ponta a ponta: listar, ler, gravar com base, conflito, só-criação, config e tema; só comandos concedidos', async () => {
    const { root, provider, handle } = await openVault();
    fs.mkdirSync(join(root, 'sub'));
    fs.writeFileSync(join(root, 'a.md'), '\uFEFFa\r\n');
    fs.writeFileSync(join(root, 'sub/c.md'), 'c');
    fs.writeFileSync(join(root, 'b.txt'), 'b');
    fs.mkdirSync(join(root, '.git'));
    expect((await provider.list(handle)).map((e) => e.path)).toEqual(['sub', 'sub/c.md', 'a.md']);
    const r = await provider.read(handle, 'a.md');
    expect(r.text).toBe('\uFEFFa\r\n');
    const w = await provider.writeIfUnchanged(handle, 'a.md', '\uFEFFa\r\nb\r\n', r);
    expect(fs.readFileSync(join(root, 'a.md'), 'utf8')).toBe('\uFEFFa\r\nb\r\n');
    fs.writeFileSync(join(root, 'a.md'), 'externo');
    const base = { text: '\uFEFFa\r\nb\r\n', mtime: w.mtime };
    expect(await codeOf(provider.writeIfUnchanged(handle, 'a.md', 'app', base))).toBe('CONFLICT');
    expect(fs.readFileSync(join(root, 'a.md'), 'utf8')).toBe('externo');
    expect(await codeOf(provider.write(handle, 'sub/c.md', 'x'))).toBe('ALREADY_EXISTS');
    await provider.write(handle, '.simplemd/themes/t/theme.json', '{}\n');
    await provider.write(handle, '.simplemd/config.json', '{"x":1}\n');
    expect((await provider.read(handle, '.simplemd/config.json')).text).toBe('{"x":1}\n');
    const before = ipc.calls.length;
    expect(await codeOf(provider.read(handle, '.git/config'))).toBe('INVALID_PATH');
    expect(ipc.calls.length).toBe(before); // a guarda do provider barra antes de qualquer IPC

    const used = [...new Set(ipc.calls.map((c) => c.cmd))].sort();
    const missing = used.filter(
      (c) => !CAPABILITY.permissions.includes(`allow-${c.replace(/_/g, '-')}`),
    );
    expect(missing).toEqual([]);
    expect(used.every((c) => !c.startsWith('plugin:'))).toBe(true);
    const writes = ipc.calls.filter((c) => c.cmd === 'vault_write_file');
    // r26: a gravação com base é uma só chamada condicional (a recusada também atravessa o IPC);
    // `create-new` não leva hash.
    expect(writes.map((c) => c.headers?.['x-simplemd-mode'])).toEqual([
      'overwrite',
      'overwrite',
      'create-new',
      'create-new',
    ]);
    expect(writes.map((c) => c.headers?.['x-simplemd-expected-sha256'])).toEqual([
      sha('\uFEFFa\r\n'),
      sha('\uFEFFa\r\nb\r\n'),
      undefined,
      undefined,
    ]);
    expect(writes.map((c) => decodeURIComponent(c.headers!['x-simplemd-rel']!))).toEqual([
      'a.md',
      'a.md',
      '.simplemd/themes/t/theme.json',
      '.simplemd/config.json',
    ]);
    // Só caminhos relativos e o token atravessam o IPC; a raiz nunca é enviada de volta.
    expect(
      JSON.stringify(
        ipc.calls.map((c) => [c.args instanceof Uint8Array ? 'bytes' : c.args, c.headers]),
      ),
    ).not.toContain(root);
  });

  test('pasta anterior: caminho fora da raiz atual → PERMISSION_DENIED com 0 chamadas IPC; token antigo recusado pelo Rust', async () => {
    const a = await openVault();
    fs.writeFileSync(join(a.root, 'x.md'), 'de A');
    const b = await openVault();
    // A porta de A também vê a troca? Não: cada porta guarda a própria abertura. Use a de B.
    const before = ipc.calls.length;
    const table: Record<string, string> = {};
    for (const [label, op] of [
      ['readFile', () => b.port.readFile(join(a.root, 'x.md'))],
      ['lstat', () => b.port.lstat(join(a.root, 'x.md'))],
      ['readDir', () => b.port.readDir(a.root)],
      [
        'writeFile',
        () => b.port.writeFile(join(a.root, 'y.md'), new Uint8Array([1]), 'create-new'),
      ],
      ['mkdirp', () => b.port.mkdirp(join(a.root, 'p'))],
    ] as const) {
      table[label] = await codeOf((op as () => Promise<unknown>)());
    }
    expect(Object.values(table).every((c) => c === 'PERMISSION_DENIED')).toBe(true);
    expect(ipc.calls.length).toBe(before);
    expect(fs.existsSync(join(a.root, 'y.md'))).toBe(false);
    // A porta de A ainda tem o token antigo: o gateway responde VAULT_CLOSED → PERMISSION_DENIED.
    expect(await codeOf(a.port.readFile(join(a.root, 'x.md')))).toBe('PERMISSION_DENIED');
    expect(ipc.calls.at(-1)).toMatchObject({
      cmd: 'vault_read_file',
      args: { token: 1, rel: 'x.md' },
    });
  });

  test('códigos do gateway → VaultError (1:1; NO_VAULT/VAULT_CLOSED → PERMISSION_DENIED; resto → IO); lstat inexistente → null', async () => {
    const { root, port } = await openVault();
    const p = join(root, 'a.md');
    fs.writeFileSync(p, 'a');
    const table: Record<string, string> = {};
    for (const code of [
      'NOT_FOUND',
      'ALREADY_EXISTS',
      'PERMISSION_DENIED',
      'INVALID_PATH',
      'OUTSIDE_VAULT',
      'TOO_LARGE',
      'CONFLICT',
      'INVALID_QUERY',
      'IO',
      'NO_VAULT',
      'VAULT_CLOSED',
      'ALGO_NOVO',
    ]) {
      gateway.failNext.set('vault_read_file', fail(code));
      table[code] = await codeOf(port.readFile(p));
    }
    gateway.failNext.set('vault_read_file', 'texto solto do Tauri');
    table.texto = await codeOf(port.readFile(p));
    expect(table).toEqual({
      NOT_FOUND: 'NOT_FOUND',
      ALREADY_EXISTS: 'ALREADY_EXISTS',
      PERMISSION_DENIED: 'PERMISSION_DENIED',
      INVALID_PATH: 'INVALID_PATH',
      OUTSIDE_VAULT: 'OUTSIDE_VAULT',
      TOO_LARGE: 'TOO_LARGE',
      CONFLICT: 'CONFLICT',
      INVALID_QUERY: 'INVALID_QUERY',
      IO: 'IO',
      NO_VAULT: 'PERMISSION_DENIED',
      VAULT_CLOSED: 'PERMISSION_DENIED',
      ALGO_NOVO: 'IO',
      texto: 'IO',
    });
    expect(await codeOf(port.lstat(join(root, 'nada.md')))).toBe('OK(null)');
    expect(await codeOf(port.writeFile(p, new Uint8Array([1]), 'create-new'))).toBe(
      'ALREADY_EXISTS',
    );
    expect(fs.readFileSync(p, 'utf8')).toBe('a');
  });

  // r37b (design-r37 §3, AC-R37B-3): a busca no texto pelo Rust — só a pasta inteira, com o token;
  // os eventos do canal chegam na ordem e o `done` resolve; o `abort` chama `vault_search_cancel`
  // com o id da busca, nada sai depois dele e o resumo diz `cancelled`; signal já abortado → 0 IPC.
  // Code review r37b NB-5: o resumo da abortada sem `done` é um objeto novo a cada vez, e abortada
  // com erro do Rust (a pasta trocou) resolve `cancelled` em vez de rejeitar.
  test('busca no texto: canal → lotes, progresso e resumo; abort → vault_search_cancel; INVALID_QUERY', async () => {
    const { root, port, provider, handle } = await openVault();
    let channel: { onmessage: (m: unknown) => void } | null = null;
    let searchId: unknown = null;
    const closing = Promise.withResolvers<never>();
    let closingSent = false;
    const emulated = gateway.handler;
    ipc.handler = (cmd, raw, options) => {
      const a = raw as Record<string, unknown>;
      if (cmd === 'vault_search_cancel') return null;
      if (cmd !== 'vault_search_text') return emulated(cmd, raw, options);
      if (a.query === 'falha') throw fail('INVALID_QUERY');
      if (a.query === 'fechada') {
        closingSent = true;
        return closing.promise;
      }
      searchId = a.searchId;
      channel = a.onEvent as { onmessage: (m: unknown) => void };
      return null;
    };
    const hit = { line: 0, col: 0, len: 4, text: 'Ação', at: 0, cutBefore: false, cutAfter: false };
    const skipped = { hidden: 0, links: 0, cloud: 0, tooLarge: 0, notUtf8: 0, unreadable: 0 };
    const delivered: string[] = [];
    const progress: number[] = [];
    const running = provider.searchText(handle, 'ação', {
      onNotes: (notes) => delivered.push(...notes.map((n) => n.path)),
      onProgress: (scanned) => progress.push(scanned),
    });
    await vi.waitFor(() => expect(channel).not.toBeNull());
    const sent = ipc.calls.find((c) => c.cmd === 'vault_search_text')?.args;
    expect(sent).toMatchObject({ token: 1, query: 'ação', limit: 200 });
    expect(JSON.stringify(sent)).not.toContain(root);
    channel!.onmessage({ notes: [{ path: 'pasta/a.md', total: 1, hits: [hit] }] });
    channel!.onmessage({ progress: 200 });
    const summary = { scanned: 200, matched: 1, truncated: false, cancelled: false, skipped };
    channel!.onmessage({ done: summary });
    expect(await running).toEqual({ status: 'done', ...summary });
    expect(delivered).toEqual(['pasta/a.md']);
    expect(progress).toEqual([200]);

    channel = null;
    const controller = new AbortController();
    const cancelled = port.searchText(root, {
      query: 'ação',
      limit: 10,
      signal: controller.signal,
      onNotes: (notes) => delivered.push(...notes.map((n) => n.path)),
    });
    await vi.waitFor(() => expect(channel).not.toBeNull());
    controller.abort();
    channel!.onmessage({ notes: [{ path: 'tarde.md', total: 1, hits: [hit] }] });
    channel!.onmessage({ done: { ...summary, matched: 2 } });
    expect(await cancelled).toMatchObject({ cancelled: true });
    expect(delivered).toEqual(['pasta/a.md']);
    const cancels = ipc.calls.filter((c) => c.cmd === 'vault_search_cancel');
    expect(cancels.map((c) => c.args)).toEqual([{ searchId }, { searchId }]);

    const before = ipc.calls.length;
    const aborted = new AbortController();
    aborted.abort();
    const early = { query: 'ação', limit: 10, signal: aborted.signal, onNotes: () => {} };
    const first = await port.searchText(root, early);
    const second = await port.searchText(root, early);
    expect(first).toEqual({ scanned: 0, matched: 0, truncated: false, cancelled: true, skipped });
    expect(second).toEqual(first);
    expect(second).not.toBe(first);
    expect(second.skipped).not.toBe(first.skipped);
    expect(ipc.calls.length).toBe(before);

    const leaving = new AbortController();
    const closed = port.searchText(root, {
      query: 'fechada',
      limit: 10,
      signal: leaving.signal,
      onNotes: () => {},
    });
    await vi.waitFor(() => expect(closingSent).toBe(true));
    leaving.abort();
    closing.reject(fail('VAULT_CLOSED'));
    expect(await closed).toEqual({
      scanned: 0,
      matched: 0,
      truncated: false,
      cancelled: true,
      skipped,
    });
    const options = { query: 'falha', limit: 10, signal: new AbortController().signal };
    expect(await codeOf(port.searchText(root, { ...options, onNotes: () => {} }))).toBe(
      'INVALID_QUERY',
    );
    for (const cmd of ['vault_search_text', 'vault_search_cancel'])
      expect(CAPABILITY.permissions).toContain(`allow-${cmd.replace(/_/g, '-')}`);
  });

  test('pick_vault: cancelar → CANCELLED; erro do Rust → código dele; o webview não envia argumentos', async () => {
    const provider = new LocalFsProvider(new TauriFsPort());
    expect(await codeOf(provider.open())).toBe('CANCELLED');
    gateway.pick = '/x';
    gateway.failNext.set('pick_vault', fail('INVALID_PATH'));
    expect(await codeOf(provider.open())).toBe('INVALID_PATH');
    expect(ipc.calls.filter((c) => c.cmd === 'pick_vault').every((c) => c.args === undefined)).toBe(
      true,
    );
  });

  test('Windows: "\\" na junção e caminho relativo POSIX no IPC', async () => {
    ipc.sep = '\\';
    gateway.handler = (cmd) =>
      cmd === 'pick_vault'
        ? { root: 'C:\\Users\\u\\Vault', token: 3 }
        : cmd === 'vault_read_dir'
          ? []
          : null;
    ipc.handler = gateway.handler;
    const port = new TauriFsPort();
    expect(await port.pickDirectory()).toBe('C:\\Users\\u\\Vault');
    const abs = port.join('C:\\Users\\u\\Vault\\', '.simplemd/themes/x/theme.json');
    expect(abs).toBe('C:\\Users\\u\\Vault\\.simplemd\\themes\\x\\theme.json');
    await port.lstat(abs);
    await port.readDir('C:\\Users\\u\\Vault');
    expect(ipc.calls.filter((c) => c.cmd.startsWith('vault_')).map((c) => c.args)).toEqual([
      { token: 3, rel: '.simplemd/themes/x/theme.json' },
      { token: 3, rel: '' },
    ]);
    expect(await codeOf(port.readFile('D:\\Outra\\x.md'))).toBe('PERMISSION_DENIED');
  });

  test('observação: caminhos relativos do Rust viram absolutos; erro → onError; parar chama vault_unwatch', async () => {
    const { root, port } = await openVault();
    const seen: string[][] = [];
    const errors: string[] = [];
    const stop = await port.watch!(
      root,
      (paths) => seen.push(paths),
      (reason) => errors.push(reason),
    );
    expect(ipc.calls.find((c) => c.cmd === 'vault_watch')?.args).toMatchObject({ token: 1 });
    gateway.watchChannel!.onmessage({ paths: ['a.md', 'sub/b.md'] });
    gateway.watchChannel!.onmessage({ error: 'falha na observação de arquivos' });
    expect(seen).toEqual([[join(root, 'a.md'), join(root, 'sub/b.md')]]);
    expect(errors).toEqual(['falha na observação de arquivos']);
    stop();
    await Promise.resolve();
    expect(ipc.calls.at(-1)).toMatchObject({ cmd: 'vault_unwatch', args: { id: 7 } });
  });

  test('r36b: `cloudOnly` do Rust — readDir só em arquivo e só quando true; lstat e listNotes levam a marca', async () => {
    const { root, port, provider, handle } = await openVault();
    fs.writeFileSync(join(root, 'nuvem.md'), 'n');
    fs.writeFileSync(join(root, 'local.md'), 'l');
    fs.mkdirSync(join(root, 'pasta'));
    // O emulador marca como o Rust (`ops::is_cloud_only`); `false` e a marca numa pasta não
    // passam da porta.
    const emulated = gateway.handler;
    ipc.handler = (cmd, raw, options) => {
      const result = emulated(cmd, raw, options);
      const rel = typeof raw === 'object' && raw !== null && 'rel' in raw ? raw.rel : null;
      const stat = typeof result === 'object' && result !== null ? result : null;
      if (cmd === 'vault_lstat' && rel === 'nuvem.md' && stat) return { ...stat, cloudOnly: true };
      if (cmd !== 'vault_read_dir' || !Array.isArray(result)) return result;
      return result.map((item: { name: string }) => ({
        ...item,
        cloudOnly: item.name !== 'local.md',
      }));
    };
    expect(await port.readDir(root)).toEqual(
      expect.arrayContaining([
        { name: 'nuvem.md', kind: 'file', size: 0, mtime: 0, cloudOnly: true },
        { name: 'local.md', kind: 'file', size: 0, mtime: 0 },
        { name: 'pasta', kind: 'dir' },
      ]),
    );
    expect(await port.lstat(join(root, 'nuvem.md'))).toMatchObject({
      kind: 'file',
      cloudOnly: true,
    });
    expect(await port.lstat(join(root, 'local.md'))).not.toHaveProperty('cloudOnly');
    const notes = await provider.listNotes(handle);
    expect(notes.find((n) => n.path === 'nuvem.md')).toMatchObject({ cloudOnly: true });
    expect(notes.find((n) => n.path === 'local.md')).not.toHaveProperty('cloudOnly');
  });

  test('code review r32a item 4: dicionário com a pasta em outra caixa é recusado no TS (0 IPC), como no Rust; a extensão ignora a caixa', async () => {
    const { root, provider, handle } = await openVault();
    fs.mkdirSync(join(root, '.simplemd', 'dictionaries'), { recursive: true });
    fs.writeFileSync(join(root, '.simplemd', 'dictionaries', 'Lista.TXT'), 'termo\n');
    const before = ipc.calls.length;
    for (const rel of ['.simplemd/Dictionaries/x.txt', '.simplemd/DICTIONARIES/x.txt']) {
      expect(await codeOf(provider.read(handle, rel))).toBe('INVALID_PATH');
      expect(await codeOf(provider.write(handle, rel, 'x'))).toBe('INVALID_PATH');
    }
    expect(ipc.calls.length).toBe(before);
    expect((await provider.read(handle, '.simplemd/dictionaries/Lista.TXT')).text).toBe('termo\n');
    // O observador também só repassa a caixa que o Rust aceita.
    const seen: string[] = [];
    const stop = provider.watch(handle, (event) => {
      if (event.kind === 'change') seen.push(...event.paths);
    });
    gateway.watchChannel!.onmessage({
      paths: ['.simplemd/Dictionaries/x.txt', '.simplemd/dictionaries/Lista.TXT'],
    });
    expect(seen).toEqual(['.simplemd/dictionaries/Lista.TXT']);
    stop();
  });
});

describe('plataforma Tauri: diálogos de exportar/importar tema por comandos Rust', () => {
  test('saveFile: escolher → token → gravar (o webview só vê o nome); cancelar → null e 0 gravações', async () => {
    const dest = join(tempDir(), 'meu-tema.theme.json');
    const platform = createTauriPlatform();
    expect(
      await platform.saveFile('meu-tema.theme.json', new Uint8Array([123, 125, 10])),
    ).toBeNull();
    expect(ipc.calls.filter((c) => c.cmd === 'save_target_write')).toEqual([]);
    gateway.savePick = dest;
    expect(await platform.saveFile('meu-tema.theme.json', new Uint8Array([123, 125, 10]))).toBe(
      'meu-tema.theme.json',
    );
    expect(fs.readFileSync(dest, 'utf8')).toBe('{}\n');
    expect(ipc.calls.find((c) => c.cmd === 'save_target_pick')?.args).toEqual({
      suggestedName: 'meu-tema.theme.json',
      ext: 'json',
    });
    expect(ipc.calls.filter((c) => c.cmd === 'save_target_write')).toHaveLength(1);
  });

  test('pickFile: dentro do teto devolve nome e bytes; acima, tamanho sem ler nada e read() rejeita', async () => {
    const dir = tempDir();
    const ok = join(dir, 'tema.theme.json');
    fs.writeFileSync(ok, '{"name":"x"}');
    const big = join(dir, 'grande.theme.json');
    fs.writeFileSync(big, ' '.repeat(300_000));
    const platform = createTauriPlatform();
    expect(await platform.pickFile!()).toBeNull();
    gateway.openPick = ok;
    const small = await platform.pickFile!();
    expect([small?.name, small?.size, new TextDecoder().decode(await small!.read())]).toEqual([
      'tema.theme.json',
      12,
      '{"name":"x"}',
    ]);
    expect(ipc.calls.find((c) => c.cmd === 'open_file_pick')?.args).toEqual({
      ext: 'json',
      maxBytes: 256 * 1024,
    });
    gateway.openPick = big;
    const picked = await platform.pickFile!();
    expect([picked?.name, picked?.size]).toEqual(['grande.theme.json', 300_000]);
    expect(await codeOf(picked!.read())).toBe('TOO_LARGE');
  });

  test('app_mark só com os valores do enum fechado', async () => {
    const platform = createTauriPlatform();
    platform.log('simplemd:ready');
    platform.log('simplemd:conflict-shown');
    await Promise.resolve();
    expect(ipc.calls.filter((c) => c.cmd === 'app_mark').map((c) => c.args)).toEqual([
      { marker: 'ready' },
      { marker: 'conflict-shown' },
    ]);
  });
});

// CR2-02 (r1 CR-02 com o gateway): a pasta do diálogo fica pendente; o que foi digitado com o
// diálogo aberto é regravado na pasta ATUAL, e só então a nova é ativada (R-CR02 da revisão).
describe('R-CR02: troca de pasta em duas fases sobre a porta de produção', () => {
  const clock = {
    now: () => Date.now(),
    setTimeout: (cb: () => void, ms: number) => setTimeout(cb, ms),
    clearTimeout: (h: unknown) => clearTimeout(h as number),
  };

  async function typedWhilePicking(failFlush: boolean) {
    const a = tempDir();
    const b = tempDir();
    fs.writeFileSync(join(a, 'nota.md'), '# N\n');
    fs.writeFileSync(join(b, 'outra.md'), '# B\n');
    const platform = createTauriPlatform();
    const app = createAppController(platform, clock, recordingRoot(), {
      internal: [],
      catalog: false,
    });
    gateway.pick = a;
    await app.sync.openVault('welcome');
    await app.sync.openFile('nota.md');
    // O diálogo está aberto (no Windows não é modal) e o usuário digita; depois escolhe B.
    const open = platform.vault.open.bind(platform.vault);
    platform.vault.open = async () => {
      const record = app.registry.get('nota.md')!;
      const { state } = record.state.update({
        changes: { from: record.state.doc.length, insert: 'digitado' },
      });
      app.sync.onEditorChange('nota.md', state);
      gateway.pick = b;
      if (failFlush) gateway.failNext.set('vault_write_file', fail('IO'));
      return open();
    };
    await app.sync.openVault('shell');
    return { a, b, app, platform };
  }

  test('regravação da pasta anterior dá certo e só depois a nova é ativada', async () => {
    const { a, b, app } = await typedWhilePicking(false);
    const s = app.store.getState();
    expect(fs.readFileSync(join(a, 'nota.md'), 'utf8')).toBe('# N\ndigitado');
    expect(s.unsavedClose).toBeNull();
    expect(s.vaultName).toBe(basename(b));
    expect(gateway.active?.root).toBe(b);
    expect(gateway.pending).toBeNull();
    expect(s.entries.map((e) => e.path)).toEqual(['outra.md']);
    // A gravação de A usou o token de A; o primeiro uso do token de B veio depois dela.
    const tokens = ipc.calls.map((c) =>
      c.cmd === 'vault_write_file' ? Number(c.headers?.['x-simplemd-token']) : null,
    );
    const writeA = ipc.calls.findIndex((c) => c.cmd === 'vault_write_file');
    const firstB = ipc.calls.findIndex(
      (c) => (c.args as { token?: number } | undefined)?.token === gateway.active?.token,
    );
    expect(tokens.filter((t) => t !== null)).toEqual([1]);
    expect(writeA).toBeGreaterThan(-1);
    expect(firstB).toBeGreaterThan(writeA);
  });

  test('regravação falhou: L4 "vault-switch", a pasta atual continua ativa e gravável', async () => {
    const { a, b, app, platform } = await typedWhilePicking(true);
    const s = app.store.getState();
    expect(s.unsavedClose).toEqual({ reason: 'vault-switch', paths: ['nota.md'] });
    expect(s.vaultName).toBe(basename(a));
    expect(gateway.active?.root).toBe(a);
    // A pasta escolhida nunca foi usada: nenhum comando com o token dela.
    const pendingToken = gateway.pending?.token;
    expect(pendingToken).toBeDefined();
    expect(
      ipc.calls.some(
        (c) =>
          (c.args as { token?: number } | undefined)?.token === pendingToken ||
          Number(c.headers?.['x-simplemd-token']) === pendingToken,
      ),
    ).toBe(false);
    expect((await platform.vault.read(s.handle!, 'nota.md')).text).toBe('# N\n');
    expect(await app.sync.retrySave('nota.md')).toBe('ok');
    expect(fs.readFileSync(join(a, 'nota.md'), 'utf8')).toBe('# N\ndigitado');
    expect(fs.existsSync(join(b, 'nota.md'))).toBe(false);
  });
});

// r26 (AC-R26-2, AC-R26-4): pelo app inteiro sobre a porta de produção, salvar é uma só chamada
// condicional (sem ler antes) e o evento que o próprio salvamento provoca no observador não vira
// mudança externa, conflito nem relistagem.
describe('r26: salvamento atômico pela porta de produção', () => {
  // Temporizadores inertes: o teste dirige o salvamento por `flush` (nenhum autosave pelo relógio).
  const clock = { now: () => Date.now(), setTimeout: () => 0, clearTimeout: () => undefined };

  test('salvar = 1 troca condicional sem leitura; o evento do próprio salvamento fica em silêncio', async () => {
    const root = tempDir();
    fs.writeFileSync(join(root, 'nota.md'), '# N\n');
    const app = createAppController(createTauriPlatform(), clock, recordingRoot(), {
      internal: [],
      catalog: false,
    });
    gateway.pick = root;
    await app.sync.openVault('welcome');
    await app.sync.openFile('nota.md');
    const record = app.registry.get('nota.md')!;
    const { state } = record.state.update({
      changes: { from: record.state.doc.length, insert: 'salvo' },
    });
    app.sync.onEditorChange('nota.md', state);
    const start = ipc.calls.length;
    await expect(app.sync.flush('nota.md')).resolves.toBe('ok');
    const save = ipc.calls.slice(start);
    expect(save.map((c) => c.cmd)).toEqual(['vault_lstat', 'vault_write_file', 'vault_lstat']);
    expect(save[1]?.headers?.['x-simplemd-expected-sha256']).toBe(sha('# N\n'));
    expect(fs.readFileSync(join(root, 'nota.md'), 'utf8')).toBe('# N\nsalvo');
    expect(fs.readdirSync(root).filter((name) => name.startsWith('.~simplemd-'))).toEqual([]);

    // O Rust repassa só o alvo da troca (`rel_of` descarta o temporário); um temporário que
    // escapasse ainda seria descartado pelo provider (oculto).
    const relists = () => ipc.calls.filter((c) => c.cmd === 'vault_read_dir').length;
    const listed = relists();
    gateway.watchChannel!.onmessage({ paths: ['.~simplemd-0123456789abcdef.tmp', 'nota.md'] });
    // A conferência da aba entrou na fila FIFO do caminho; este flush roda depois dela.
    await expect(app.sync.flush('nota.md')).resolves.toBe('ok');
    const s = app.store.getState();
    expect(s.notices.filter((n) => n.notice === 'external-reload')).toEqual([]);
    expect(s.conflict).toBeNull();
    expect(s.docs['nota.md']).toBe('clean');
    expect(relists()).toBe(listed);
  });
});

// r7 SN (arch-backend §5.2): a porta e a plataforma Tauri chamam os 5 comandos novos com os
// argumentos exatos, e todos estão concedidos na capability.
describe('r7: imagens, abrir URL e LanguageTool pela plataforma Tauri', () => {
  const PNG = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d);
  const granted = (cmd: string) =>
    CAPABILITY.permissions.includes(`allow-${cmd.replace(/_/g, '-')}`);

  test('readImage chama vault_read_image com {token, rel}; UNSUPPORTED_IMAGE vira VaultError com o mesmo código', async () => {
    const { root, provider, handle } = await openVault();
    fs.mkdirSync(join(root, 'img'));
    fs.writeFileSync(join(root, 'img/a.png'), PNG);
    fs.writeFileSync(join(root, 'img/falso.png'), '<!doctype html>');
    const image = await provider.readImage(handle, 'img/a.png');
    expect([...image.bytes]).toEqual([...PNG]);
    expect(image.mime).toBe('image/png');
    expect(ipc.calls.filter((c) => c.cmd === 'vault_read_image').map((c) => c.args)).toEqual([
      { token: 1, rel: 'img/a.png' },
    ]);
    expect(ipc.calls.some((c) => c.cmd === 'vault_read_file')).toBe(false);
    gateway.failNext.set('vault_read_image', fail('UNSUPPORTED_IMAGE'));
    const error = await provider.readImage(handle, 'img/falso.png').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(VaultError);
    expect((error as VaultError).code).toBe('UNSUPPORTED_IMAGE');
    expect(granted('vault_read_image')).toBe(true);
  });

  test('openUrl chama open_url com {url}; a recusa do Rust chega como {code}', async () => {
    const platform = createTauriPlatform();
    await platform.openUrl('https://exemplo.org/a?b=1#c');
    expect(ipc.calls.filter((c) => c.cmd === 'open_url').map((c) => c.args)).toEqual([
      { url: 'https://exemplo.org/a?b=1#c' },
    ]);
    gateway.failNext.set('open_url', fail('RATE_LIMITED'));
    await expect(platform.openUrl('https://exemplo.org/')).rejects.toMatchObject({
      code: 'RATE_LIMITED',
    });
    expect(granted('open_url')).toBe(true);
    expect(CAPABILITY.permissions.some((p) => /^(opener|shell):/.test(p))).toBe(false);
  });

  test('languageTool: lt_languages sem argumentos, lt_check com {requestId, req}, lt_cancel com {requestId}', async () => {
    const { languageTool } = createTauriPlatform();
    const req = { language: 'pt-BR', annotation: [{ text: 'Isso é uma excessão.' }] };
    expect(await languageTool.languages()).toBe('[{"longCode":"pt-BR"}]');
    expect(await languageTool.check(req, 7)).toBe('{"matches":[]}');
    await languageTool.cancel(7);
    expect(ipc.calls.filter((c) => c.cmd.startsWith('lt_')).map((c) => [c.cmd, c.args])).toEqual([
      ['lt_languages', undefined],
      ['lt_check', { requestId: 7, req }],
      ['lt_cancel', { requestId: 7 }],
    ]);
    gateway.failNext.set('lt_check', fail('CONNECTION_REFUSED'));
    await expect(languageTool.check(req, 8)).rejects.toMatchObject({ code: 'CONNECTION_REFUSED' });
    for (const cmd of ['lt_languages', 'lt_check', 'lt_cancel'])
      expect(granted(cmd), cmd).toBe(true);
  });

  test('F-08: requestId fora de [0, 2³²) → {code: LT_INVALID_REQUEST} sem IPC', async () => {
    const { languageTool } = createTauriPlatform();
    const req = { language: 'pt-BR', annotation: [{ text: 'a' }] };
    ipc.calls.length = 0;
    for (const id of [-1, 1.5, 2 ** 32, Number.NaN]) {
      await expect(languageTool.check(req, id)).rejects.toMatchObject({
        code: 'LT_INVALID_REQUEST',
      });
      await expect(languageTool.cancel(id)).rejects.toMatchObject({ code: 'LT_INVALID_REQUEST' });
    }
    expect(ipc.calls).toEqual([]);
    expect(await languageTool.check(req, 2 ** 32 - 1)).toBe('{"matches":[]}');
  });

  test('F-09: readConfigFile ponta a ponta sobre a TauriFsPort (vault_lstat + vault_read_file)', async () => {
    const { root, provider, handle } = await openVault();
    fs.writeFileSync(join(root, '.markdownlint.json'), '{"MD013": false}');
    fs.mkdirSync(join(root, '.simplemd'));
    expect(await provider.readConfigFile(handle, '.markdownlint.json')).toMatchObject({
      text: '{"MD013": false}',
    });
    expect(await provider.readConfigFile(handle, '.markdownlint.jsonc')).toBeNull();
    expect(await provider.readConfigFile(handle, '.simplemd/latex-snippets.json')).toBeNull();
    const used = ipc.calls.map((c) => [c.cmd, (c.args as { rel?: string } | undefined)?.rel]);
    expect(used).toContainEqual(['vault_lstat', '.markdownlint.json']);
    expect(used).toContainEqual(['vault_read_file', '.markdownlint.json']);
    expect(used.filter(([cmd]) => cmd === 'vault_read_file')).toHaveLength(1);
  });
});

// r32a (AC-R32A-1/AC-R32A-3 pelo TS): a plataforma Tauri fala com a camada global só pelos 2
// comandos novos, com os argumentos exatos (nome, texto e sha256 da base; nunca um caminho), e os
// dois estão concedidos. O gateway emulado é o falso do harness: a tabela abaixo é a mesma dos
// testes Rust de `vault/dictionaries.rs`, então o falso e o Rust respondem igual (D-R32-3).
describe('r32a: camada global de dicionários pela plataforma Tauri', () => {
  const granted = (cmd: string) =>
    CAPABILITY.permissions.includes(`allow-${cmd.replace(/_/g, '-')}`);
  /** Código do erro do Rust (`{ code, message }`), ou `OK`. */
  const rustCode = (p: Promise<unknown>) =>
    p.then(
      () => 'OK',
      (error: { code?: string }) => error.code ?? `RAW ${String(error)}`,
    );

  test('dict_global_read sem argumentos, dict_global_write com {name, text, expectedSha256}; o erro do Rust chega com o código', async () => {
    const { dictionaries } = createTauriPlatform();
    expect(await dictionaries.readGlobal()).toEqual({ files: [], skipped: 0 });
    await dictionaries.writeGlobal('pessoal.txt', 'colecistectomia\n', null);
    expect(await dictionaries.readGlobal()).toEqual({
      files: [{ name: 'pessoal.txt', text: 'colecistectomia\n', sha256: sha('colecistectomia\n') }],
      skipped: 0,
    });
    await dictionaries.writeGlobal('pessoal.txt', 'exceção\n', sha('colecistectomia\n'));
    expect(ipc.calls.filter((c) => c.cmd.startsWith('dict_')).map((c) => [c.cmd, c.args])).toEqual([
      ['dict_global_read', undefined],
      [
        'dict_global_write',
        { name: 'pessoal.txt', text: 'colecistectomia\n', expectedSha256: null },
      ],
      ['dict_global_read', undefined],
      [
        'dict_global_write',
        { name: 'pessoal.txt', text: 'exceção\n', expectedSha256: sha('colecistectomia\n') },
      ],
    ]);
    expect(gateway.dictionaries.control.text('pessoal.txt')).toBe('exceção\n');
    gateway.failNext.set('dict_global_write', fail('IO'));
    await expect(dictionaries.writeGlobal('pessoal.txt', 'x\n', null)).rejects.toMatchObject({
      code: 'IO',
    });
    for (const cmd of ['dict_global_read', 'dict_global_write'])
      expect(granted(cmd), cmd).toBe(true);
  });

  test('gravação: só pessoal.txt nasce, base errada → CONFLICT sem gravar, nome/hash inválido, teto e link', async () => {
    const { dictionaries } = createTauriPlatform();
    const fake = gateway.dictionaries.control;
    const write = (name: string, text: string, expected: string | null) =>
      rustCode(dictionaries.writeGlobal(name, text, expected));
    expect(await write('medicos.txt', 'x\n', null)).toBe('PERMISSION_DENIED');
    expect(await write('pessoal.txt', 'base\n', null)).toBe('OK');
    expect(await write('pessoal.txt', 'outro\n', null)).toBe('ALREADY_EXISTS');
    expect(await write('pessoal.txt', 'app\n', sha('outra base\n'))).toBe('CONFLICT');
    expect(fake.text('pessoal.txt')).toBe('base\n');
    expect(await write('nada.txt', 'x\n', sha(''))).toBe('NOT_FOUND');
    fake.put('medicos.txt', 'antigo\n');
    expect(await write('medicos.txt', 'novo\n', sha('antigo\n'))).toBe('OK');
    for (const name of [
      '',
      'pessoal',
      'pessoal.md',
      'a/pessoal.txt',
      '../pessoal.txt',
      '.pessoal.txt',
      'pessoal.txt.',
      'a\\pessoal.txt',
      'con.txt',
    ])
      expect(await write(name, 'x\n', null), name).toBe('INVALID_PATH');
    const base = sha('base\n');
    for (const hash of [base.toUpperCase(), base.slice(1), `${base}0`, 'não-hex'])
      expect(await write('pessoal.txt', 'x\n', hash), hash).toBe('INVALID_PATH');
    const over = 'a'.repeat(10 * 1024 * 1024 + 1);
    await expect(dictionaries.writeGlobal('pessoal.txt', over, base)).rejects.toMatchObject({
      code: 'TOO_LARGE',
      detail: { size: over.length },
    });
    expect(await write('pessoal.txt', 'a'.repeat(10 * 1024 * 1024), base)).toBe('OK');
    fake.link('link.txt');
    expect(await write('link.txt', 'x\n', sha(''))).toBe('OUTSIDE_VAULT');
    // `calls()` do falso nunca guarda o texto, só nome, tamanho e resultado.
    expect(JSON.stringify(fake.calls())).not.toContain('antigo');
  });

  test('leitura: pessoal.txt primeiro e o resto pelos bytes do nome, erro por arquivo, tetos da camada', async () => {
    const { dictionaries } = createTauriPlatform();
    const fake = gateway.dictionaries.control;
    fake.put('zeta.txt', 'z\n');
    fake.put('pessoal.txt', 'p\n');
    fake.put('Beta.txt', '\uFEFFb\r\n');
    fake.put('alfa.txt', 'a\n');
    fake.put('grande.txt', new Uint8Array(10 * 1024 * 1024 + 1));
    fake.put('latin1.txt', Uint8Array.of(0x63, 0x61, 0x66, 0xe9, 0x0a));
    fake.link('link.txt');
    fake.put('notas.md', 'x');
    fake.put('.oculto.txt', 'x');
    expect(await dictionaries.readGlobal()).toEqual({
      files: [
        { name: 'pessoal.txt', text: 'p\n', sha256: sha('p\n') },
        { name: 'Beta.txt', text: '\uFEFFb\r\n', sha256: sha('\uFEFFb\r\n') },
        { name: 'alfa.txt', text: 'a\n', sha256: sha('a\n') },
        { name: 'grande.txt', error: 'TOO_LARGE' },
        { name: 'latin1.txt', error: 'NOT_UTF8' },
        { name: 'link.txt', error: 'OUTSIDE_VAULT' },
        { name: 'zeta.txt', text: 'z\n', sha256: sha('z\n') },
      ],
      skipped: 0,
    });

    fake.reset();
    for (let i = 0; i < 17; i++) fake.put(`d${String(i).padStart(2, '0')}.txt`, `t${i}\n`);
    const sixteen = await dictionaries.readGlobal();
    expect([sixteen.files.length, sixteen.skipped, sixteen.files.at(-1)?.name]).toEqual([
      16,
      1,
      'd15.txt',
    ]);

    fake.reset();
    const seven = new Uint8Array(7 * 1024 * 1024).fill(0x78);
    for (const name of ['pessoal.txt', 'b.txt', 'c.txt']) fake.put(name, seven);
    fake.put('d.txt', 'd\n');
    const budget = await dictionaries.readGlobal();
    expect([budget.files.map((f) => f.name), budget.skipped]).toEqual([
      ['pessoal.txt', 'b.txt', 'd.txt'],
      1,
    ]);
  });
});

// r33a: listas de termos pela plataforma Tauri — `dict_import` com `{ layer, token }` e
// `dict_manage` com `{ layer, token, name, action }`; o token vai só na camada da pasta (sem pasta,
// `NO_VAULT` sem IPC nem diálogo) e os dois comandos estão concedidos na capability.
describe('r33a: importar, renomear e remover listas pela plataforma Tauri', () => {
  const granted = (cmd: string) =>
    CAPABILITY.permissions.includes(`allow-${cmd.replace(/_/g, '-')}`);

  test('a global sem token, a da pasta com o da pasta aberta; sem pasta → NO_VAULT sem IPC', async () => {
    const platform = createTauriPlatform();
    const { dictionaries } = platform;
    await expect(dictionaries.import('folder')).rejects.toMatchObject({ code: 'NO_VAULT' });
    await expect(dictionaries.rename('folder', 'a.txt', 'b.txt')).rejects.toMatchObject({
      code: 'NO_VAULT',
    });
    await expect(dictionaries.remove('folder', 'a.txt')).rejects.toMatchObject({
      code: 'NO_VAULT',
    });
    expect(ipc.calls.filter((c) => c.cmd.startsWith('dict_'))).toEqual([]);

    expect(await dictionaries.import('global')).toEqual({
      name: 'termos-medicos.txt',
      words: 50_000,
      discarded: 0,
      encoding: 'UTF-8',
      pair: false,
    });
    await dictionaries.rename('global', 'termos-medicos.txt', 'medicos.txt');
    expect(gateway.dictionaries.control.names()).toEqual(['medicos.txt']);
    await dictionaries.remove('global', 'medicos.txt');
    expect(gateway.dictionaries.control.names()).toEqual([]);

    gateway.pick = tempDir();
    platform.vault.activate(await platform.vault.open());
    const token = gateway.pending?.token;
    expect(typeof token).toBe('number');
    gateway.folderImport = {
      name: 'medicos.txt',
      words: 1,
      discarded: 0,
      encoding: 'UTF-8',
      pair: false,
    };
    expect(await dictionaries.import('folder')).toEqual(gateway.folderImport);
    await dictionaries.rename('folder', 'medicos.txt', 'cardio.txt');
    await dictionaries.remove('folder', 'cardio.txt');
    const rename = (to: string) => ({ rename: { to } });
    expect(ipc.calls.filter((c) => c.cmd.startsWith('dict_')).map((c) => [c.cmd, c.args])).toEqual([
      ['dict_import', { layer: 'global', token: null }],
      [
        'dict_manage',
        {
          layer: 'global',
          token: null,
          name: 'termos-medicos.txt',
          action: rename('medicos.txt'),
        },
      ],
      ['dict_manage', { layer: 'global', token: null, name: 'medicos.txt', action: 'remove' }],
      ['dict_import', { layer: 'folder', token }],
      [
        'dict_manage',
        { layer: 'folder', token, name: 'medicos.txt', action: rename('cardio.txt') },
      ],
      ['dict_manage', { layer: 'folder', token, name: 'cardio.txt', action: 'remove' }],
    ]);
    gateway.failNext.set('dict_import', fail('BUSY'));
    await expect(dictionaries.import('global')).rejects.toMatchObject({ code: 'BUSY' });
    for (const cmd of ['dict_import', 'dict_manage']) expect(granted(cmd), cmd).toBe(true);
  });
});

// r35a (AC-R35A-1): a porta Tauri do corretor chama os 3 comandos da r34 com os argumentos exatos
// (`spell_reload` com o token só no escopo `folder` e com uma pasta aberta), todos concedidos na
// capability, e mapeia os erros pelo código (`TIMEOUT` e `CANCELLED` inclusive; a mensagem do Rust
// não passa). O app recarrega a cada pasta aberta, com o token dela e antes da listagem, repete no
// `CANCELLED` que vem de fora e, na volta às boas-vindas, recarrega só a camada global.
describe('r35a: corretor offline pela plataforma Tauri', () => {
  const granted = (cmd: string) =>
    CAPABILITY.permissions.includes(`allow-${cmd.replace(/_/g, '-')}`);
  const spellCalls = () =>
    ipc.calls.filter((c) => c.cmd.startsWith('spell_')).map((c) => [c.cmd, c.args]);
  const RELOADED = { langs: ['pt-BR'], words: 0, pairs: 0, skipped: 0 };

  test('spell_check {lang, words}, spell_suggest {lang, word}, spell_reload sem token sem pasta, com o da pasta no escopo folder e sem ele no global', async () => {
    const platform = createTauriPlatform();
    const { spell } = platform;
    const words = ['Isso', 'é', 'uma', 'excessão'];
    expect(await spell.check('pt-BR', words)).toEqual([3]);
    expect(await spell.suggest('pt-BR', 'excessão')).toEqual(['exceção']);
    expect(await spell.reload('folder')).toEqual(RELOADED);
    gateway.pick = tempDir();
    platform.vault.activate(await platform.vault.open());
    const token = gateway.pending?.token;
    expect(typeof token).toBe('number');
    expect(await spell.reload('folder')).toEqual(RELOADED);
    expect(await spell.reload('global')).toEqual(RELOADED);
    expect(spellCalls()).toEqual([
      ['spell_check', { lang: 'pt-BR', words }],
      ['spell_suggest', { lang: 'pt-BR', word: 'excessão' }],
      ['spell_reload', {}],
      ['spell_reload', { token }],
      ['spell_reload', {}],
    ]);
    // Como o `VaultState::root`: o primeiro uso do token da pasta pendente a ativa.
    expect(gateway.active?.token).toBe(token);
    for (const cmd of ['spell_check', 'spell_suggest', 'spell_reload'])
      expect(granted(cmd), cmd).toBe(true);
  });

  test('erros pelo código: TIMEOUT com seconds e a mensagem do corretor, CANCELLED, TOO_MANY_WORDS com max; outro código ou sem código → IO', async () => {
    const { spell } = createTauriPlatform();
    const rustTimeout = fail('TIMEOUT', { seconds: 3 });
    rustTimeout.message = 'O servidor não respondeu a tempo.';
    gateway.failNext.set('spell_check', rustTimeout);
    const timeout = await spell.check('pt-BR', ['a']).catch((e: unknown) => e);
    expect(timeout).toEqual({
      code: 'TIMEOUT',
      message: 'O corretor demorou demais; tente de novo.',
      detail: { seconds: 3 },
    });
    const table: Array<[string, GatewayError | string, Record<string, unknown>]> = [
      ['spell_suggest', fail('CANCELLED'), { code: 'CANCELLED' }],
      [
        'spell_check',
        fail('TOO_MANY_WORDS', { max: 20_000 }),
        { code: 'TOO_MANY_WORDS', detail: { max: 20_000 } },
      ],
      ['spell_check', fail('UNSUPPORTED_LANG'), { code: 'UNSUPPORTED_LANG' }],
      ['spell_reload', fail('VAULT_CLOSED'), { code: 'VAULT_CLOSED' }],
      ['spell_reload', fail('NO_VAULT'), { code: 'NO_VAULT' }],
      ['spell_reload', fail('SPELL_UNAVAILABLE'), { code: 'SPELL_UNAVAILABLE' }],
      ['spell_reload', fail('CANCELLED', { max: 1 }), { code: 'CANCELLED' }],
      ['spell_suggest', fail('LT_HTTP_STATUS', { status: 500 }), { code: 'IO' }],
      ['spell_check', 'invalid args `words` for command `spell_check`', { code: 'IO' }],
    ];
    for (const [cmd, error, expected] of table) {
      gateway.failNext.set(cmd, error);
      const pending =
        cmd === 'spell_check'
          ? spell.check('pt-BR', ['a'])
          : cmd === 'spell_suggest'
            ? spell.suggest('pt-BR', 'a')
            : spell.reload('folder');
      const got = (await pending.catch((e: unknown) => e)) as Record<string, unknown>;
      const { message, ...rest } = got;
      expect(rest, `${cmd} ${JSON.stringify(error)}`).toEqual(expected);
      expect(typeof message).toBe('string');
      expect(message).not.toBe('falha');
    }
  });

  // Temporizadores inertes, como no r26: nada aqui depende do relógio.
  const inertClock = { now: () => Date.now(), setTimeout: () => 0, clearTimeout: () => undefined };
  /** `spell_reload` sai antes do primeiro `vault_read_dir` nas chamadas a partir de `from`. */
  const reloadBeforeListing = (from: number) => {
    const cmds = ipc.calls.slice(from).map((c) => c.cmd);
    const reload = cmds.indexOf('spell_reload');
    expect(reload).toBeGreaterThanOrEqual(0);
    expect(reload).toBeLessThan(cmds.indexOf('vault_read_dir'));
  };

  test('o app recarrega a cada pasta aberta, com o token dela e antes da listagem, e repete no CANCELLED de fora', async () => {
    const app = createAppController(createTauriPlatform(), inertClock, recordingRoot(), {
      internal: [],
      catalog: false,
    });
    gateway.pick = tempDir();
    await app.sync.openVault('welcome');
    const first = gateway.active?.token;
    // code-review r35a N4: a recarga sai antes da listagem da pasta (não só com o token novo).
    reloadBeforeListing(0);
    gateway.pick = tempDir();
    // Um plugin aprovado recarregou por fora logo antes: a recarga do app sai com CANCELLED.
    gateway.failNext.set('spell_reload', fail('CANCELLED'));
    const switchAt = ipc.calls.length;
    await app.sync.openVault('shell');
    const second = gateway.active?.token;
    expect(second).not.toBe(first);
    reloadBeforeListing(switchAt);
    await vi.waitFor(() =>
      expect(spellCalls()).toEqual([
        ['spell_reload', { token: first }],
        ['spell_reload', { token: second }],
        ['spell_reload', { token: second }],
      ]),
    );
    expect(gateway.spell.control.calls().map((c) => [c.op, c.outcome])).toEqual([
      ['reload', 'ok'],
      ['reload', 'ok'],
    ]);
  });

  test('a pasta que não lista, das boas-vindas: a volta recarrega só a camada global, sem o token que ficou na porta', async () => {
    // code-review r35a N1 / AppSec r35a N2: o token do `TauriFsPort` nunca zera e o Rust ainda trata
    // a pasta que não abriu como ativa; a recarga da volta não pode levá-lo.
    const app = createAppController(createTauriPlatform(), inertClock, recordingRoot(), {
      internal: [],
      catalog: false,
    });
    gateway.pick = tempDir();
    gateway.failNext.set('vault_read_dir', fail('PERMISSION_DENIED'));
    await app.sync.openVault('welcome');
    expect(app.store.getState().vaultStatus).toBe('closed');
    const token = gateway.active?.token;
    expect(typeof token).toBe('number');
    await vi.waitFor(() =>
      expect(spellCalls()).toEqual([
        ['spell_reload', { token }],
        ['spell_reload', {}],
      ]),
    );
  });
});
