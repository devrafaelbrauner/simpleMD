import { describe, expect, test } from 'vitest';
import { LocalFsProvider, isJsonObject, updateJsonFile, type VaultProvider } from '../src';
import { MemoryFsPort } from '../src/testing';

const PATH = '.simplemd/config.json';

async function setup(files: Record<string, string | Uint8Array>) {
  const port = new MemoryFsPort();
  port.seed(files);
  const provider = new LocalFsProvider(port, {
    readLimits: [{ match: (p) => p === PATH, maxBytes: 64 }],
  });
  const handle = await provider.open();
  const writes = () => port.calls().filter((c) => c.op === 'writeFile');
  return { port, provider, handle, writes };
}

const setA = (obj: Record<string, unknown>) => {
  obj.a = 2;
};

describe('updateJsonFile (arch-backend §1.6)', () => {
  test('inexistente: cria a pasta e o arquivo com gravação só-criação', async () => {
    const s = await setup({ 'n.md': '' });
    await expect(updateJsonFile(s.provider, s.handle, PATH, setA)).resolves.toMatchObject({
      status: 'written',
    });
    expect(s.port.readText(PATH)).toBe('{\n  "a": 2\n}\n');
    expect(s.writes().map((c) => c.mode)).toEqual(['create-new']);
  });

  test('API-02: um BOM inicial não torna o arquivo malformado; a regravação sai sem BOM', async () => {
    const s = await setup({ [PATH]: '\uFEFF{"z":0}' });
    await expect(updateJsonFile(s.provider, s.handle, PATH, setA)).resolves.toMatchObject({
      status: 'written',
    });
    expect(s.port.readText(PATH)).toBe('{\n  "z": 0,\n  "a": 2\n}\n');
  });

  test('existente: mescla mantendo chaves e ordem; grava com o mtime lido', async () => {
    const s = await setup({ [PATH]: '{"z":0,"a":1,"n":{"k":true}}' });
    await updateJsonFile(s.provider, s.handle, PATH, setA);
    expect(s.port.readText(PATH)).toBe(
      '{\n  "z": 0,\n  "a": 2,\n  "n": {\n    "k": true\n  }\n}\n',
    );
    expect(s.writes().map((c) => c.mode)).toEqual(['overwrite']);
  });

  test.each([
    ['JSON inválido', '{"a":'],
    ['raiz lista', '[]'],
    ['raiz nula', 'null'],
    ['UTF-8 inválido', new Uint8Array([0x7b, 0xc3, 0x28, 0x7d])],
    ['grande demais (readLimits)', `{"a":"${'x'.repeat(80)}"}`],
  ])('malformado (%s): nada é gravado', async (_case, content) => {
    const s = await setup({ [PATH]: content });
    await expect(updateJsonFile(s.provider, s.handle, PATH, setA)).resolves.toEqual({
      status: 'malformed',
    });
    expect(s.writes()).toEqual([]);
  });

  test('erro de leitura que não é "não encontrado" sobe sem gravar', async () => {
    const s = await setup({ [PATH]: '{}' });
    s.port.failNext('readFile', 'PERMISSION_DENIED');
    await expect(updateJsonFile(s.provider, s.handle, PATH, setA)).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });
    expect(s.writes()).toEqual([]);
  });

  test('outro programa sempre grava no meio: desiste depois das novas tentativas', async () => {
    const s = await setup({ [PATH]: '{}' });
    let n = 0;
    const racing: VaultProvider = {
      open: () => s.provider.open(),
      list: (h, dir) => s.provider.list(h, dir),
      async read(h, path) {
        const result = await s.provider.read(h, path);
        s.port.externalWrite(PATH, `{"externo":${++n}}`);
        return result;
      },
      write: (h, path, text, mtime) => s.provider.write(h, path, text, mtime),
    };
    await expect(
      updateJsonFile(racing, s.handle, PATH, setA, { retries: 1 }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(n).toBe(2);
    expect(s.port.readText(PATH)).toBe('{"externo":2}');
  });

  test('isJsonObject', () => {
    expect([{}, { a: 1 }].every(isJsonObject)).toBe(true);
    expect([null, [], 'x', 1].some(isJsonObject)).toBe(false);
  });
});
