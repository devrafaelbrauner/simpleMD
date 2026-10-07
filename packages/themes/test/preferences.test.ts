import { createHash } from 'node:crypto';
import { LocalFsProvider, type VaultHandle, type VaultProvider } from '@simplemd/vault';
import { MemoryFsPort } from '@simplemd/vault/testing';
import { describe, expect, test } from 'vitest';
import {
  CONFIG_PATH,
  DEFAULT_PREFERENCES,
  VAULT_READ_LIMITS,
  isBuiltinThemeId,
  loadPreferences,
  savePreferences,
  type Preferences,
} from '../src';

async function vault(files: Record<string, string | Uint8Array> = {}) {
  const port = new MemoryFsPort();
  port.seed({ 'nota.md': '# Nota\n', ...files });
  const provider = new LocalFsProvider(port, { readLimits: VAULT_READ_LIMITS });
  const handle = await provider.open();
  const sha = () => {
    const bytes = port.readBytes(CONFIG_PATH);
    return bytes === null ? null : createHash('sha256').update(bytes).digest('hex');
  };
  const writes = () => port.calls().filter((c) => c.op === 'writeFile').length;
  return { port, provider, handle, sha, writes };
}

const CHANGED: Preferences = {
  theme: 'simplemd-dark',
  fontFamily: 'Fira Code',
  fontSize: 18,
  fontLigatures: false,
};

describe('loadPreferences (R-4.6, AC-4.11)', () => {
  test('sem config.json: padrões, sem avisos e nada é criado', async () => {
    const v = await vault();
    await expect(loadPreferences(v.provider, v.handle, isBuiltinThemeId)).resolves.toEqual({
      status: 'missing',
      prefs: DEFAULT_PREFERENCES,
      warnings: [],
    });
    expect(v.writes()).toBe(0);
    await expect(v.port.lstat('/vault/.simplemd')).resolves.toBeNull();
  });

  test.each([
    ['JSON truncado', '{ "theme": ', 'JSON malformado'],
    ['lista na raiz', '[1, 2]', 'o conteúdo não é um objeto JSON'],
    ['UTF-8 inválido', new Uint8Array([0x7b, 0xff, 0x7d]), 'JSON malformado'],
    ['maior que 1 MB', `{"x":"${'a'.repeat(1_048_577)}"}`, 'maior que 1 MB'],
  ])('malformado (%s): padrões + aviso; o sha256 não muda', async (_case, content, reason) => {
    const v = await vault({ [CONFIG_PATH]: content });
    const before = v.sha();
    const loaded = await loadPreferences(v.provider, v.handle, isBuiltinThemeId);
    expect(loaded).toEqual({
      status: 'malformed',
      prefs: DEFAULT_PREFERENCES,
      warnings: [{ field: 'arquivo', reason }],
    });
    expect(v.sha()).toBe(before);
    expect(v.writes()).toBe(0);
  });

  test('erro de leitura (permissão): padrões e status "unreadable"', async () => {
    const v = await vault({ [CONFIG_PATH]: '{}' });
    v.port.failNext('readFile', 'PERMISSION_DENIED');
    const loaded = await loadPreferences(v.provider, v.handle, isBuiltinThemeId);
    expect(loaded.status).toBe('unreadable');
    expect(loaded.prefs).toBe(DEFAULT_PREFERENCES);
  });

  test('campos inválidos caem no padrão do campo com aviso; tamanho é limitado', async () => {
    const v = await vault({
      [CONFIG_PATH]: JSON.stringify({
        theme: 'nao-existe',
        editor: { fontFamily: 'Comic Sans', fontSize: 99, fontLigatures: 'sim' },
      }),
    });
    const loaded = await loadPreferences(v.provider, v.handle, isBuiltinThemeId);
    expect(loaded.status).toBe('ok');
    expect(loaded.prefs).toEqual({ ...DEFAULT_PREFERENCES, fontSize: 32 });
    expect(loaded.warnings.map((w) => w.field)).toEqual([
      'theme',
      'editor.fontFamily',
      'editor.fontSize',
      'editor.fontLigatures',
    ]);
    const bad = await vault({ [CONFIG_PATH]: '{"theme":"../x","editor":[]}' });
    const badLoaded = await loadPreferences(bad.provider, bad.handle, isBuiltinThemeId);
    expect(badLoaded.warnings).toEqual([
      { field: 'theme', reason: 'id de tema inválido' },
      { field: 'editor', reason: 'deve ser um objeto' },
    ]);
  });

  test('config válido é restaurado', async () => {
    const v = await vault({
      [CONFIG_PATH]: JSON.stringify({ theme: CHANGED.theme, editor: { ...CHANGED } }),
    });
    const loaded = await loadPreferences(v.provider, v.handle, isBuiltinThemeId);
    expect(loaded).toEqual({ status: 'ok', prefs: CHANGED, warnings: [] });
  });

  test('API-02: config.json com BOM é lido (não é "malformado") e pode ser gravado', async () => {
    const v = await vault({ [CONFIG_PATH]: '\uFEFF{"theme":"simplemd-dark","x":1}\n' });
    const loaded = await loadPreferences(v.provider, v.handle, isBuiltinThemeId);
    expect(loaded.status).toBe('ok');
    expect(loaded.prefs.theme).toBe('simplemd-dark');
    await expect(savePreferences(v.provider, v.handle, CHANGED)).resolves.toMatchObject({
      status: 'written',
    });
    expect(JSON.parse(v.port.readText(CONFIG_PATH) ?? '')).toMatchObject({
      x: 1,
      theme: 'simplemd-dark',
    });
  });
});

describe('savePreferences (AC-4.9)', () => {
  test('ler-mesclar-gravar: chave desconhecida {"x":1} continua; nova sessão restaura', async () => {
    const v = await vault({ [CONFIG_PATH]: '{"x":1}' });
    await expect(savePreferences(v.provider, v.handle, CHANGED)).resolves.toMatchObject({
      status: 'written',
    });
    // Ordem existente preservada, chaves novas no fim, 2 espaços e `\n` final.
    const expected = {
      x: 1,
      theme: 'simplemd-dark',
      editor: { fontFamily: 'Fira Code', fontSize: 18, fontLigatures: false },
    };
    expect(v.port.readText(CONFIG_PATH)).toBe(`${JSON.stringify(expected, null, 2)}\n`);

    // "Nova sessão": outro provider sobre o mesmo disco.
    const again = new LocalFsProvider(v.port, { readLimits: VAULT_READ_LIMITS });
    const handle = await again.open();
    const loaded = await loadPreferences(again, handle, isBuiltinThemeId);
    expect(loaded.prefs).toEqual(CHANGED);
  });

  test('cria .simplemd/config.json quando não existe; chaves de editor desconhecidas ficam', async () => {
    const v = await vault();
    await savePreferences(v.provider, v.handle, CHANGED);
    expect(JSON.parse(v.port.readText(CONFIG_PATH) ?? '')).toMatchObject({ theme: CHANGED.theme });
    const kept = await vault({ [CONFIG_PATH]: '{"editor":{"wrap":true,"fontSize":12},"y":[1]}' });
    await savePreferences(kept.provider, kept.handle, CHANGED);
    expect(JSON.parse(kept.port.readText(CONFIG_PATH) ?? '')).toEqual({
      editor: { wrap: true, fontSize: 18, fontFamily: 'Fira Code', fontLigatures: false },
      y: [1],
      theme: 'simplemd-dark',
    });
  });

  test('arquivo malformado: devolve "malformed" e grava 0 bytes (F-9)', async () => {
    const v = await vault({ [CONFIG_PATH]: '{ "theme": ' });
    const before = v.sha();
    await expect(savePreferences(v.provider, v.handle, CHANGED)).resolves.toEqual({
      status: 'malformed',
    });
    expect(v.writes()).toBe(0);
    expect(v.sha()).toBe(before);
  });

  test('outro programa grava no meio: relê, mescla e não perde as chaves dele', async () => {
    const v = await vault({ [CONFIG_PATH]: '{"x":1}' });
    let raced = false;
    const racing: VaultProvider = {
      open: () => v.provider.open(),
      list: (h, dir) => v.provider.list(h, dir),
      async read(h: VaultHandle, path: string) {
        const result = await v.provider.read(h, path);
        if (!raced) {
          raced = true;
          v.port.externalWrite(CONFIG_PATH, '{"x":1,"outro":"programa"}\n');
        }
        return result;
      },
      write: (h, path, text, mtime) => v.provider.write(h, path, text, mtime),
    };
    await savePreferences(racing, v.handle, CHANGED);
    expect(JSON.parse(v.port.readText(CONFIG_PATH) ?? '')).toEqual({
      x: 1,
      outro: 'programa',
      theme: 'simplemd-dark',
      editor: { fontFamily: 'Fira Code', fontSize: 18, fontLigatures: false },
    });
  });
});
