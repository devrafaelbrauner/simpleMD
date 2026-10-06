import { describe, expect, test } from 'vitest';
import {
  LocalFsProvider,
  VaultError,
  conflictCopyCandidate,
  createWithFreeName,
} from '../src/index';
import { MemoryFsPort } from '../src/testing/index';

const AT = new Date(2026, 9, 6, 9, 5, 7);

describe('conflictCopyCandidate', () => {
  test('formato "<nome> (conflito AAAA-MM-DD HH-mm-ss).md", depois " 2", " 3"…', () => {
    expect(conflictCopyCandidate('nota.md', AT, 1)).toBe('nota (conflito 2026-10-06 09-05-07).md');
    expect(conflictCopyCandidate('sub/nota.md', AT, 2)).toBe(
      'sub/nota (conflito 2026-10-06 09-05-07) 2.md',
    );
    expect(conflictCopyCandidate('a.b/c.MD', AT, 3)).toBe(
      'a.b/c (conflito 2026-10-06 09-05-07) 3.MD',
    );
  });
});

describe('createWithFreeName', () => {
  async function setup(files: Record<string, string>) {
    const port = new MemoryFsPort();
    port.seed(files);
    const provider = new LocalFsProvider(port);
    return { port, provider, handle: await provider.open() };
  }

  test('nome ocupado → variante " 2"; o arquivo existente fica intacto', async () => {
    const taken = conflictCopyCandidate('nota.md', AT, 1);
    const { port, provider, handle } = await setup({ 'nota.md': 'disco', [taken]: 'ocupado' });
    const result = await createWithFreeName(
      provider,
      handle,
      (n) => conflictCopyCandidate('nota.md', AT, n),
      'buffer',
    );
    expect(result.path).toBe('nota (conflito 2026-10-06 09-05-07) 2.md');
    expect(port.readText(taken)).toBe('ocupado');
    expect(port.readText(result.path)).toBe('buffer');
    expect(
      port
        .calls()
        .filter((c) => c.op === 'writeFile')
        .map((c) => c.mode),
    ).toEqual(['create-new']);
  });

  test('outro erro sobe; esgotar as tentativas → ALREADY_EXISTS', async () => {
    const { port, provider, handle } = await setup({ 'a.md': '', 'b.md': '' });
    port.failNext('writeFile', 'PERMISSION_DENIED');
    await expect(createWithFreeName(provider, handle, () => 'novo.md', 'x')).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });
    const error = await createWithFreeName(
      provider,
      handle,
      (n) => (n === 1 ? 'a.md' : 'b.md'),
      'x',
      {
        max: 2,
      },
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(VaultError);
    expect(error).toMatchObject({ code: 'ALREADY_EXISTS' });
  });
});
