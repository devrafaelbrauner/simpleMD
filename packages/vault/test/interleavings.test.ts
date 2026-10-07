import { describe, expect, test } from 'vitest';
import {
  ConflictError,
  LocalFsProvider,
  conflictCopyCandidate,
  createWithFreeName,
  type VaultHandle,
} from '../src/index';
import { MemoryFsPort } from '../src/testing/index';

/** PRNG determinístico (mulberry32): a mesma semente sempre gera a mesma sequência. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FILE = 'nota.md';
const STEPS = 40;
const decoder = new TextDecoder();

interface Outcome {
  overwrites: number;
  violations: string[];
  missing: string[];
}

/**
 * Um cenário intercala, na granularidade de operação, edições do app, autosaves, checagens de
 * mudança externa, escritas externas e toques de mtime. O app segue o protocolo da arquitetura:
 * salvar sempre com a base de conteúdo (`writeIfUnchanged` com o texto visto por último, RR-03);
 * conflito → "Manter ambos" (cópia só-criação + recarregar).
 */
async function runScenario(seed: number, mtimeResolutionMs: number): Promise<Outcome> {
  const random = mulberry32(seed);
  const port = new MemoryFsPort({ mtimeResolutionMs });
  port.seed({ [FILE]: 'v0' });
  const provider = new LocalFsProvider(port);
  const handle: VaultHandle = await provider.open();
  const outcome: Outcome = { overwrites: 0, violations: [], missing: [] };

  let { text: disk, mtime } = await provider.read(handle, FILE);
  let buffer = disk;
  let copyClock = 0;
  const externalVersions: string[] = [];
  const seenByApp = new Set<string>([disk]);
  const savedCopies: string[] = [];

  // Oráculo NFR-13: uma sobrescrita só acontece quando o disco tem os bytes que o app viu por último.
  const realWrite = port.writeFile.bind(port);
  port.writeFile = async (abs, data, mode) => {
    if (mode === 'overwrite') {
      outcome.overwrites++;
      const current = port.readText(FILE);
      if (current !== disk)
        outcome.violations.push(`seed ${seed}: sobrescreveu "${current}" sem tê-lo visto`);
    }
    return realWrite(abs, data, mode);
  };

  const keepBoth = async () => {
    const at = new Date(2026, 0, 1, 0, 0, copyClock++);
    const copy = await createWithFreeName(
      provider,
      handle,
      (n) => conflictCopyCandidate(FILE, at, n),
      buffer,
    );
    savedCopies.push(copy.path);
    ({ text: disk, mtime } = await provider.read(handle, FILE));
    seenByApp.add(disk);
    buffer = disk;
  };

  const save = async () => {
    try {
      ({ mtime } = await provider.writeIfUnchanged(handle, FILE, buffer, { text: disk, mtime }));
      disk = buffer;
      seenByApp.add(disk);
    } catch (error) {
      if (!(error instanceof ConflictError)) throw error;
      await keepBoth();
    }
  };

  const check = async () => {
    const read = await provider.read(handle, FILE);
    if (read.text === disk) {
      mtime = read.mtime;
      return;
    }
    if (buffer === disk) {
      // Aba limpa: recarrega do disco, 0 escritas (AC-2.13).
      disk = read.text;
      mtime = read.mtime;
      buffer = disk;
      seenByApp.add(disk);
    } else {
      await keepBoth();
    }
  };

  for (let step = 0; step < STEPS; step++) {
    const roll = random();
    if (roll < 0.35) buffer += String.fromCharCode(97 + Math.floor(random() * 26));
    else if (roll < 0.6) await save();
    else if (roll < 0.75) await check();
    else if (roll < 0.92) {
      const version = `externo-${seed}-${step}`;
      externalVersions.push(version);
      port.externalWrite(FILE, version);
    } else port.touch(FILE);
  }
  await save(); // flush final (fechar a janela)

  const onDisk = new Set<string>();
  for (const path of [FILE, ...savedCopies]) {
    const bytes = port.readBytes(path);
    if (bytes) onDisk.add(decoder.decode(bytes));
  }
  if (!onDisk.has(buffer)) outcome.missing.push(`seed ${seed}: buffer final ausente do disco`);
  const lastExternal = externalVersions.at(-1);
  if (lastExternal !== undefined && !onDisk.has(lastExternal) && !seenByApp.has(lastExternal)) {
    outcome.missing.push(`seed ${seed}: versão externa "${lastExternal}" perdida sem ser vista`);
  }
  return outcome;
}

describe('NFR-13: 200 intercalações com semente fixa, 0 bytes perdidos', () => {
  test.each([1, 2000])('mtimeResolutionMs = %i (100 sementes)', async (resolution) => {
    let overwrites = 0;
    const problems: string[] = [];
    for (let seed = 1; seed <= 100; seed++) {
      const outcome = await runScenario(seed, resolution);
      overwrites += outcome.overwrites;
      problems.push(...outcome.violations, ...outcome.missing);
    }
    expect(problems).toEqual([]);
    expect(overwrites).toBeGreaterThan(100); // o cenário exercita sobrescritas de fato
  });
});
