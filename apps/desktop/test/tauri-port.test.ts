// Contrato da porta de produção (TauriFsPort + plataforma Tauri) contra um gateway Rust emulado
// (arch-backend r2 §1.2, V-P6; fecha TA-3). O emulador segue os comandos `vault_*`,
// `save_target_*` e `open_file_pick` sobre pastas reais em /tmp. A política nativa em si (classes,
// links, tetos, troca de pasta) é provada pelos testes Rust (`cargo test`).
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, sep as nativeSep } from 'node:path';
import { LocalFsProvider, VaultError } from '@simplemd/vault';
import { afterAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { TauriFsPort } from '../src/platform/tauri/fsPort';
import { createTauriPlatform } from '../src/platform/tauri/platform';

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

/** Gateway emulado: uma pasta ativa por vez, token novo a cada `pick_vault`. */
class FakeGateway {
  pick: string | null = null;
  active: { root: string; token: number } | null = null;
  savePick: string | null = null;
  openPick: string | null = null;
  readonly targets = new Map<string, string>();
  readonly failNext = new Map<string, GatewayError | string>();
  watchChannel: { onmessage: (m: unknown) => void } | null = null;
  #token = 0;

  #root(token: unknown): string {
    if (!this.active) throw fail('NO_VAULT');
    if (token !== this.active.token) throw fail('VAULT_CLOSED');
    return this.active.root;
  }

  #path(token: unknown, rel: string): string {
    const root = this.#root(token);
    if (rel.split('/').some((s) => s === '..')) throw fail('OUTSIDE_VAULT');
    if (rel.split('/').some((s, i) => s.startsWith('.') && !(i === 0 && s === '.simplemd')))
      throw fail('PERMISSION_DENIED');
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
        this.active = { root: this.pick, token: ++this.#token };
        this.targets.clear();
        return { ...this.active };
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
        if (mode === 'overwrite' && !fs.existsSync(p)) throw fail('NOT_FOUND');
        this.#io(() =>
          fs.writeFileSync(p, raw as Uint8Array, { flag: mode === 'create-new' ? 'wx' : 'r+' }),
        );
        if (mode === 'overwrite') fs.truncateSync(p, (raw as Uint8Array).length);
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
    expect(writes.map((c) => c.headers?.['x-simplemd-mode'])).toEqual([
      'overwrite',
      'create-new',
      'create-new',
    ]);
    expect(writes.map((c) => decodeURIComponent(c.headers!['x-simplemd-rel']!))).toEqual([
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
