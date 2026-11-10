// r41e: nomes de dicionário. `fixtures/dictionary-names.json` é a MESMA tabela lida pelo teste Rust
// (`vault::policy`, `dictionary_names_follow_the_shared_fixture`): `isDictionaryName` recusa
// exatamente o que `policy::dictionary_name` recusa (Default_Ignorable, caixa, teto em pontos de
// código) e a classe de dicionário do provider, exatamente o que `policy::file_class` recusa.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { LocalFsProvider, VaultError, isDictionaryName } from '../src/index';
import { MemoryFsPort } from '../src/testing';

type Item =
  | string
  | {
      readonly prefix?: string;
      readonly repeat: string;
      readonly times: number;
      readonly suffix?: string;
    };

interface Fixture {
  readonly names: { readonly accept: readonly Item[]; readonly refuse: readonly Item[] };
  readonly paths: { readonly accept: readonly Item[]; readonly refuse: readonly Item[] };
  readonly refusedInside: ReadonlyArray<readonly [from: string, to: string]>;
}

const FIXTURE = JSON.parse(
  readFileSync(join(__dirname, 'fixtures/dictionary-names.json'), 'utf8'),
) as Fixture;

const text = (item: Item): string =>
  typeof item === 'string'
    ? item
    : `${item.prefix ?? ''}${item.repeat.repeat(item.times)}${item.suffix ?? ''}`;

/** Rótulo curto e legível (os nomes longos e os invisíveis viram `\u{…}`). */
const label = (name: string): string => {
  const shown = [...name]
    .map((c) =>
      /^[\p{L}\p{N}\p{P}\p{S} ]$/u.test(c) ? c : `\\u{${c.codePointAt(0)?.toString(16)}}`,
    )
    .join('');
  return shown.length > 60 ? `${shown.slice(0, 40)}…(${[...name].length} pontos)` : shown;
};

const RANGES = FIXTURE.refusedInside.map(([from, to]) => [parseInt(from, 16), parseInt(to, 16)]);

describe('isDictionaryName = policy::dictionary_name (dictionary-names.json)', () => {
  test('a tabela é a do Rust: nomes aceitos e recusados', () => {
    expect(FIXTURE.names.accept.length).toBeGreaterThanOrEqual(20);
    expect(FIXTURE.names.refuse.length).toBeGreaterThanOrEqual(80);
    const accepted = FIXTURE.names.accept.map(text);
    const refused = FIXTURE.names.refuse.map(text);
    expect(accepted.filter((name) => !isDictionaryName(name)).map(label)).toEqual([]);
    expect(refused.filter((name) => isDictionaryName(name)).map(label)).toEqual([]);
  });

  test('"a{c}.txt": recusado exatamente nos pontos de código de refusedInside (todo o Unicode)', () => {
    const wrong: string[] = [];
    for (let c = 0; c <= 0x10ffff; c++) {
      if (c >= 0xd800 && c <= 0xdfff) continue;
      const accepted = isDictionaryName(`a${String.fromCodePoint(c)}.txt`);
      const refused = RANGES.some(([from = 0, to = 0]) => c >= from && c <= to);
      if (accepted === refused) wrong.push(`U+${c.toString(16).toUpperCase()}`);
    }
    expect(wrong).toEqual([]);
  });

  test('só no TS: metade de par substituto (nenhuma String do Rust a carrega) é recusada', () => {
    for (const name of ['a\ud800.txt', 'a\udc00.txt', '\ud83d.txt', 'a\ude00b.txt'])
      expect(isDictionaryName(name), label(name)).toBe(false);
  });
});

describe('classe de dicionário do provider = policy::file_class (dictionary-names.json)', () => {
  async function provider() {
    const port = new MemoryFsPort();
    const vault = new LocalFsProvider(port);
    const handle = await vault.open();
    vault.activate(handle);
    return { port, vault, handle };
  }

  test('aceitos: gravados e lidos (até 1.024 pontos de código no caminho)', async () => {
    const { vault, handle } = await provider();
    for (const rel of FIXTURE.paths.accept.map(text)) {
      await expect(vault.write(handle, rel, 'termo\n'), label(rel)).resolves.toBeTruthy();
      await expect(vault.read(handle, rel), label(rel)).resolves.toMatchObject({
        text: 'termo\n',
      });
    }
  });

  test('recusados antes de tocar a porta (caixa do prefixo, subpasta, invisível, dispositivo, teto)', async () => {
    const { port, vault, handle } = await provider();
    for (const rel of FIXTURE.paths.refuse.map(text)) {
      await expect(vault.write(handle, rel, 'termo\n'), label(rel)).rejects.toBeInstanceOf(
        VaultError,
      );
      await expect(vault.read(handle, rel), label(rel)).rejects.toBeInstanceOf(VaultError);
    }
    expect(port.calls().filter((call) => call.op === 'writeFile')).toEqual([]);
  });
});
