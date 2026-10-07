import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import {
  ConflictError,
  LocalFsProvider,
  sha256Hex,
  updateJsonFile,
  type ContentBase,
} from '../src/index';
import { MemoryFsPort } from '../src/testing/index';

const T0 = 1_700_000_000_000;
const sha = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');

async function setup(files: Record<string, string>, frozen = false) {
  const port = new MemoryFsPort(frozen ? { mtimeResolutionMs: 2000, now: () => T0 } : {});
  port.seed(files);
  const provider = new LocalFsProvider(port);
  const handle = await provider.open();
  const writes = () => port.calls().filter((c) => c.op === 'writeFile').length;
  return { port, provider, handle, writes };
}

const outcome = (p: Promise<unknown>) =>
  p.then(
    () => 'written',
    (error: unknown) => (error instanceof ConflictError ? `CONFLICT:${error.reason}` : error),
  );

describe('sha256Hex', () => {
  test('igual ao sha256 do Node (vazio, ASCII, UTF-8 com BOM)', () => {
    const enc = new TextEncoder();
    for (const text of ['', 'abc', '\uFEFF# Título\r\nção ✓\n']) {
      expect(sha256Hex(enc.encode(text))).toBe(sha(enc.encode(text)));
    }
    expect(sha256Hex(new Uint8Array())).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });
});

describe('RR-03 (AC-P.2): escrita externa no mesmo tique de mtime + segundo leitor', () => {
  test('a escrita §4.3 com a base antiga vira ConflictError; o disco fica com os bytes externos', async () => {
    const { port, provider, handle, writes } = await setup({ 'n.md': 'base' }, true);
    const { mtime } = await provider.read(handle, 'n.md');
    port.externalWrite('n.md', 'ext');
    await provider.read(handle, 'n.md'); // segundo leitor (prévia, índice, plugin…)
    const before = writes();
    await expect(outcome(provider.write(handle, 'n.md', 'app', mtime))).resolves.toBe(
      'CONFLICT:modified',
    );
    expect(writes()).toBe(before);
    expect(sha(port.readText('n.md') ?? '')).toBe(sha('ext'));
  });

  test('writeIfUnchanged com a base de texto também recusa, com 0 bytes gravados', async () => {
    const { port, provider, handle, writes } = await setup({ 'n.md': 'base' }, true);
    const { text, mtime } = await provider.read(handle, 'n.md');
    port.externalWrite('n.md', 'ext');
    await provider.read(handle, 'n.md');
    const before = writes();
    await expect(
      outcome(provider.writeIfUnchanged(handle, 'n.md', 'app', { text, mtime })),
    ).resolves.toBe('CONFLICT:modified');
    expect(writes()).toBe(before);
    expect(port.readText('n.md')).toBe('ext');
  });

  test('sem segundo leitor, a escrita externa no mesmo tique é pega pela comparação de conteúdo', async () => {
    const { port, provider, handle } = await setup({ 'n.md': 'base' }, true);
    const { mtime } = await provider.read(handle, 'n.md');
    port.externalWrite('n.md', 'ext');
    await expect(outcome(provider.write(handle, 'n.md', 'app', mtime))).resolves.toBe(
      'CONFLICT:modified',
    );
    expect(port.readText('n.md')).toBe('ext');
  });
});

describe('writeIfUnchanged (D-B1, V-P2)', () => {
  const bases = (text: string, mtime: number): Array<[string, ContentBase]> => [
    ['texto', { text, mtime }],
    ['sha256', { sha256: sha(text), mtime }],
  ];

  test.each(['texto', 'sha256'])('base por %s: disco igual à base → grava', async (kind) => {
    const { port, provider, handle } = await setup({ 'n.md': 'v1' });
    const { text, mtime } = await provider.read(handle, 'n.md');
    const base = bases(text, mtime).find(([k]) => k === kind)![1];
    const result = await provider.writeIfUnchanged(handle, 'n.md', 'v2', base);
    expect(port.readText('n.md')).toBe('v2');
    expect(result.mtime).not.toBe(mtime);
  });

  test.each(['texto', 'sha256'])(
    'base por %s: mudança externa → CONFLICT e sha256 do disco inalterado',
    async (kind) => {
      const { port, provider, handle, writes } = await setup({ 'n.md': 'v1' });
      const { text, mtime } = await provider.read(handle, 'n.md');
      port.externalWrite('n.md', 'externo');
      const base = bases(text, mtime).find(([k]) => k === kind)![1];
      const before = writes();
      const error = await provider
        .writeIfUnchanged(handle, 'n.md', 'app', base)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ConflictError);
      expect(error).toMatchObject({ reason: 'modified', expectedMtime: mtime, path: 'n.md' });
      expect(writes()).toBe(before);
      expect(sha(port.readText('n.md') ?? '')).toBe(sha('externo'));
    },
  );

  test('toque só de mtime (D-4) → grava', async () => {
    const { port, provider, handle } = await setup({ 'n.md': 'v1' });
    const { text, mtime } = await provider.read(handle, 'n.md');
    port.touch('n.md');
    await provider.writeIfUnchanged(handle, 'n.md', 'v2', { text, mtime });
    expect(port.readText('n.md')).toBe('v2');
  });

  test('bytes iguais aos novos → 0 gravações', async () => {
    const { provider, handle, writes } = await setup({ 'n.md': 'igual' });
    const { text, mtime } = await provider.read(handle, 'n.md');
    const before = writes();
    await expect(
      provider.writeIfUnchanged(handle, 'n.md', 'igual', { text, mtime }),
    ).resolves.toEqual({ mtime });
    expect(writes()).toBe(before);
  });

  test('arquivo removido → ConflictError "deleted" e nada é recriado', async () => {
    const { port, provider, handle } = await setup({ 'n.md': 'v1' });
    const { text, mtime } = await provider.read(handle, 'n.md');
    port.remove('n.md');
    await expect(
      outcome(provider.writeIfUnchanged(handle, 'n.md', 'app', { text, mtime })),
    ).resolves.toBe('CONFLICT:deleted');
    expect(port.readText('n.md')).toBeNull();
  });

  test('o mtime da base nunca autoriza: mtime igual e conteúdo diferente → CONFLICT', async () => {
    const { port, provider, handle } = await setup({ 'n.md': 'v1' }, true);
    const { mtime } = await provider.read(handle, 'n.md');
    port.externalWrite('n.md', 'v1-externo');
    await expect(
      outcome(provider.writeIfUnchanged(handle, 'n.md', 'app', { text: 'v1', mtime })),
    ).resolves.toBe('CONFLICT:modified');
  });

  test('CRLF + BOM: a base de texto com BOM e CRLF casa byte a byte com o disco', async () => {
    const raw = '\uFEFF# T\r\nlinha\r\n';
    const { port, provider, handle } = await setup({ 'n.md': raw });
    const { text, mtime } = await provider.read(handle, 'n.md');
    await provider.writeIfUnchanged(handle, 'n.md', '\uFEFF# T\r\nnova\r\n', { text, mtime });
    expect(port.readText('n.md')).toBe('\uFEFF# T\r\nnova\r\n');
  });

  test('10 escritas concorrentes com a mesma base e relógio congelado → 1 gravada, 9 CONFLICT', async () => {
    const { port, provider, handle } = await setup({ 'n.md': 'base' }, true);
    const base = await provider.read(handle, 'n.md');
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        outcome(provider.writeIfUnchanged(handle, 'n.md', `w${i}`, base)),
      ),
    );
    const written = results.flatMap((r, i) => (r === 'written' ? [`w${i}`] : []));
    expect(written).toHaveLength(1);
    expect(results.filter((r) => r === 'CONFLICT:modified')).toHaveLength(9);
    expect(port.readText('n.md')).toBe(written[0]);
  });
});

describe('escrita §4.3 com expectedMtime: base pelo registro de versões servidas', () => {
  test('gravações seguidas no mesmo tique, cada uma com o mtime da anterior → todas gravadas', async () => {
    const { port, provider, handle } = await setup({ 'n.md': 'v0' }, true);
    let { mtime } = await provider.read(handle, 'n.md');
    for (let i = 1; i <= 20; i++) {
      ({ mtime } = await provider.write(handle, 'n.md', `v${i}`, mtime));
    }
    expect(port.readText('n.md')).toBe('v20');
  });

  test('um mtime que o provider nunca serviu não autoriza, mesmo igual ao do disco', async () => {
    const { port, provider, handle } = await setup({ 'n.md': 'v1' });
    await provider.read(handle, 'n.md');
    port.externalWrite('n.md', 'v2');
    const stat = await port.lstat(port.join(handle.root, 'n.md'));
    await expect(outcome(provider.write(handle, 'n.md', 'app', stat!.mtime))).resolves.toBe(
      'CONFLICT:modified',
    );
    expect(port.readText('n.md')).toBe('v2');
  });

  test('caminho sem histórico neste provider: vale a regra do r1 (mtime igual → grava)', async () => {
    const { port, provider, handle } = await setup({ 'n.md': 'v1' });
    const stat = await port.lstat(port.join(handle.root, 'n.md'));
    await expect(outcome(provider.write(handle, 'n.md', 'x', stat!.mtime - 1))).resolves.toBe(
      'CONFLICT:modified',
    );
    await expect(outcome(provider.write(handle, 'n.md', 'x', stat!.mtime))).resolves.toBe(
      'written',
    );
  });

  test('o registro guarda no máximo 16 versões: uma base despejada não autoriza mais', async () => {
    const { provider, handle } = await setup({ 'n.md': 'v0' });
    const first = await provider.read(handle, 'n.md');
    let base = first;
    for (let i = 1; i <= 16; i++) {
      const { mtime } = await provider.writeIfUnchanged(handle, 'n.md', `v${i}`, base);
      base = { text: `v${i}`, mtime };
    }
    // A versão v0 saiu do registro; o disco é v16, então a base v0 também não casaria.
    await expect(outcome(provider.write(handle, 'n.md', 'x', first.mtime))).resolves.toBe(
      'CONFLICT:modified',
    );
    await expect(outcome(provider.write(handle, 'n.md', 'x', base.mtime))).resolves.toBe('written');
  });
});

describe('updateJsonFile usa a base de conteúdo', () => {
  test('com LocalFsProvider grava por writeIfUnchanged (nenhuma escrita §4.3 com mtime)', async () => {
    const { port, provider, handle } = await setup({ '.simplemd/config.json': '{"x":1}' });
    const calls: string[] = [];
    const spied = Object.assign(Object.create(provider) as LocalFsProvider, {
      write: (...args: Parameters<LocalFsProvider['write']>) => {
        calls.push('write');
        return provider.write(...args);
      },
      writeIfUnchanged: (...args: Parameters<LocalFsProvider['writeIfUnchanged']>) => {
        calls.push('writeIfUnchanged');
        return provider.writeIfUnchanged(...args);
      },
      read: (...args: Parameters<LocalFsProvider['read']>) => provider.read(...args),
    });
    await updateJsonFile(spied, handle, '.simplemd/config.json', (obj) => {
      obj.y = 2;
    });
    expect(calls).toEqual(['writeIfUnchanged']);
    expect(port.readText('.simplemd/config.json')).toBe('{\n  "x": 1,\n  "y": 2\n}\n');
  });

  test('outro programa grava no mesmo tique entre a leitura e a gravação → relê e mantém as chaves dele', async () => {
    const { port, provider, handle } = await setup({ '.simplemd/config.json': '{"x":1}' }, true);
    let raced = false;
    const racing = Object.assign(Object.create(provider) as LocalFsProvider, {
      read: async (...args: Parameters<LocalFsProvider['read']>) => {
        const result = await provider.read(...args);
        if (!raced) {
          raced = true;
          port.externalWrite('.simplemd/config.json', '{"x":1,"outro":true}');
        }
        return result;
      },
      writeIfUnchanged: (...args: Parameters<LocalFsProvider['writeIfUnchanged']>) =>
        provider.writeIfUnchanged(...args),
    });
    await expect(
      updateJsonFile(racing, handle, '.simplemd/config.json', (obj) => {
        obj.y = 2;
      }),
    ).resolves.toMatchObject({ status: 'written' });
    expect(JSON.parse(port.readText('.simplemd/config.json') ?? '')).toEqual({
      x: 1,
      outro: true,
      y: 2,
    });
  });
});
