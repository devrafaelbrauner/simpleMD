// Troca de pasta em duas fases no provider (CR2-02) e o registro de versões servidas por pasta
// (CR2-11): `activate` repassa à porta e esquece as versões das pastas fechadas; `abandon` só
// desiste da pendente.
import { describe, expect, test } from 'vitest';
import { ConflictError, LocalFsProvider, type FsPort } from '../src/index';
import { MemoryFsPort } from '../src/testing/index';

const outcome = (p: Promise<unknown>) =>
  p.then(
    () => 'written',
    (error: unknown) => (error instanceof ConflictError ? `CONFLICT:${error.reason}` : error),
  );

describe('troca de pasta em duas fases', () => {
  test('activate/abandon chegam à porta com a raiz do handle; porta de uma fase não precisa', async () => {
    const memory = new MemoryFsPort();
    const steps: string[] = [];
    const port: FsPort = {
      pickDirectory: () => memory.pickDirectory(),
      activateDirectory: (root) => void steps.push(`activate ${root}`),
      abandonDirectory: (root) => void steps.push(`abandon ${root}`),
      join: (r, p) => memory.join(r, p),
      readDir: (a) => memory.readDir(a),
      lstat: (a) => memory.lstat(a),
      readFile: (a) => memory.readFile(a),
      writeFile: (a, d, m) => memory.writeFile(a, d, m),
      mkdirp: (a) => memory.mkdirp(a),
    };
    const provider = new LocalFsProvider(port);
    const first = await provider.open();
    provider.abandon(first);
    const second = await provider.open();
    provider.activate(second);
    expect(steps).toEqual([`abandon ${first.root}`, `activate ${second.root}`]);
    // Porta sem as duas fases (memória, Node): os dois são no-op.
    const single = new LocalFsProvider(new MemoryFsPort());
    const handle = await single.open();
    expect(() => single.activate(handle)).not.toThrow();
    expect(() => single.abandon(handle)).not.toThrow();
  });

  test('CR2-11: ativar outra pasta esquece as versões servidas da anterior; a ativa mantém as suas', async () => {
    const port = new MemoryFsPort();
    port.seed({ 'a.md': 'v1' });
    const provider = new LocalFsProvider(port);
    const old = await provider.open();
    provider.activate(old);
    await provider.read(old, 'a.md');
    port.externalWrite('a.md', 'externo');
    const changed = (await provider.stat(old, 'a.md'))!.mtime;
    // Com o registro: um mtime que este provider nunca serviu não autoriza nada (RR-03).
    provider.activate(old);
    expect(await outcome(provider.write(old, 'a.md', 'app', changed))).toBe('CONFLICT:modified');
    expect(port.readText('a.md')).toBe('externo');

    const next = await provider.open();
    provider.activate(next);
    // Registro da pasta fechada descartado: o handle antigo não tem mais histórico (regra do r1).
    expect(await outcome(provider.write(old, 'a.md', 'app', changed))).toBe('written');
  });
});
