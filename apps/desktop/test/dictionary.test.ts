import { createHash } from 'node:crypto';
import type * as Vault from '@simplemd/vault';
import { describe, expect, test, vi } from 'vitest';
import {
  DICTIONARY_LIMITS,
  FOLDER_DICTIONARY_DIR,
  inDictionary,
  normalizeWord,
  parseWordList,
} from '../src/state/dictionary';
import { setup, type Harness } from './helpers';

// O sha256 puro-JS (@noble/hashes) fica ~13× mais lento sob a cobertura v8 do CI: os 3 hashes de
// 10 MiB de "pessoal.txt passaria de 10 MiB" passavam de 5 s no Linux. Mesmo digest (ver
// content-base.test.ts), calculado em C++ pelo Node; a semântica da gravação condicional não muda.
vi.mock('@simplemd/vault', async (importOriginal) => ({
  ...(await importOriginal<typeof Vault>()),
  sha256Hex: (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex'),
}));

/**
 * r32b — dicionário do usuário no app (design-r32 §1, §5; D-R32-1..6): o formato v1 (vetores que a
 * r33 repete no Rust), a regra de caixa que saiu do LanguageTool, as camadas global (falso
 * `h.dictionaries`, a semântica dos comandos Rust) e da pasta (vault em memória), a união, a
 * gravação condicional, os tetos e os avisos.
 */

const MIB = 1024 * 1024;
const DIR = FOLDER_DICTIONARY_DIR;

/** App com a pasta aberta, o serviço em uso (uma assinatura) e as cargas terminadas. */
async function started(
  files: Record<string, string | Uint8Array> = {},
  global: Record<string, string | Uint8Array> = {},
) {
  const h = await setup({ 'nota.md': '# Nota\n', ...files });
  for (const [name, content] of Object.entries(global)) h.dictionaries.put(name, content);
  const dictionary = h.app.dictionary;
  const changes = vi.fn();
  dictionary.subscribe(changes);
  await dictionary.ready();
  return { h, dictionary, changes };
}

const globalWrites = (h: Harness) => h.dictionaries.calls().filter((c) => c.op === 'write');
const folderCalls = (h: Harness, op: string) =>
  h.port.calls().filter((c) => c.op === op && c.abs.includes(`/${DIR}`));

describe('formato v1 (D-P26-03; vetores da r33)', () => {
  test('termo: NFC sem espaços nas pontas; 1–64 caracteres; sem espaço, controle nem formatação invisível', () => {
    const nfd = 'excessão'.normalize('NFD');
    expect(nfd).not.toBe('excessão');
    const cases: Array<[string, string | null]> = [
      ['excessão', 'excessão'],
      ['  excessão \r', 'excessão'],
      [nfd, 'excessão'],
      ['e\u0301', 'é'],
      ['', null],
      ['   ', null],
      ['# comentário', null],
      ['#hashtag', null],
      ['duas palavras', null],
      ['tab\tdentro', null],
      ['sem\u00a0quebra', null],
      ['sino\u0007', null],
      ['bidi\u202eabc', null],
      ['largura\u200bzero', null],
      ['hífen\u00admole', null],
      ['meio\ud800par', null],
      ['a'.repeat(64), 'a'.repeat(64)],
      ['a'.repeat(65), null],
      ['😀'.repeat(64), '😀'.repeat(64)],
      ['😀'.repeat(65), null],
      ['ã'.normalize('NFD').repeat(64), 'ã'.repeat(64)],
    ];
    expect(cases.map(([raw]) => normalizeWord(raw))).toEqual(cases.map(([, term]) => term));
  });

  test('arquivo: BOM e CRLF saem; comentários e linhas vazias não contam; duplicata (também NFD) sai', () => {
    const text = [
      '\uFEFF# Dicionário da clínica\r',
      'excessão\r',
      '\r',
      'Excessão',
      'excessão',
      'excessão'.normalize('NFD'),
      '  medicação  ',
      'duas palavras',
      '',
    ].join('\n');
    expect(parseWordList(text)).toEqual(['excessão', 'Excessão', 'medicação']);
    expect(parseWordList('')).toEqual([]);
  });

  test('CR-S8 N3: a regra de caixa do LanguageTool (movida de field.ts), em NFC', () => {
    const lower = new Set(['excessão']);
    expect(
      ['excessão', 'Excessão', 'EXCESSÃO', 'ExcesSão'].map((w) => inDictionary(lower, w)),
    ).toEqual([true, true, true, false]);
    const capital = new Set(['Brasil']);
    expect(['Brasil', 'brasil', 'BRASIL'].map((w) => inDictionary(capital, w))).toEqual([
      true,
      false,
      false,
    ]);
    expect(inDictionary(lower, 'Excessão'.normalize('NFD'))).toBe(true);
  });
});

describe('serviço: carga sob demanda e camadas', () => {
  test('nada é lido antes do primeiro uso; a 1ª assinatura lê as duas camadas', async () => {
    const h = await setup({ 'nota.md': '# Nota\n' });
    const { dictionary } = h.app;
    expect(dictionary.getSnapshot().global.status).toBe('idle');
    expect(dictionary.getSnapshot().folder.status).toBe('idle');
    expect(h.dictionaries.calls()).toEqual([]);
    expect(folderCalls(h, 'readDir')).toEqual([]);
    dictionary.subscribe(() => {});
    await dictionary.ready();
    expect(h.dictionaries.calls()).toEqual([{ op: 'read', files: 0, skipped: 0, outcome: 'ok' }]);
    const snapshot = dictionary.getSnapshot();
    expect([snapshot.global.status, snapshot.folder.status]).toEqual(['ready', 'ready']);
    expect(dictionary.getSnapshot()).toBe(snapshot);
  });

  test('AC-R32-2: os `.txt` da pasta valem nela (pessoal.txt primeiro, depois a ordem dos bytes do nome)', async () => {
    const { dictionary } = await started({
      [`${DIR}/b.txt`]: 'bê\n',
      [`${DIR}/a.txt`]: '# comentário\nexcessão\n',
      [`${DIR}/pessoal.txt`]: 'pessoal\nbê\n',
      [`${DIR}/notas.md`]: 'naoconta\n',
      [`${DIR}/sem-extensao`]: 'naoconta\n',
      [`${DIR}/a\u202eb.txt`]: 'naoconta\n',
    });
    expect(dictionary.getSnapshot().folder.terms).toEqual(['pessoal', 'bê', 'excessão']);
    expect(
      ['Excessão', 'EXCESSÃO', 'excessão'.normalize('NFD')].map((w) => dictionary.known(w)),
    ).toEqual([true, true, true]);
    expect(['comentário', 'naoconta'].map((w) => dictionary.known(w))).toEqual([false, false]);
    expect(dictionary.takeWarnings()).toEqual([]);
  });

  test('AC-R32-2: um `.txt` novo (outro programa, sincronização) vale sem reabrir a pasta', async () => {
    const { h, dictionary, changes } = await started();
    const before = changes.mock.calls.length;
    h.port.externalWrite(`${DIR}/clinica.txt`, 'zebrinha\n');
    await vi.waitFor(() => expect(dictionary.known('zebrinha')).toBe(true));
    expect(changes.mock.calls.length).toBeGreaterThan(before);
    h.port.externalWrite(`${DIR}/clinica.txt`, 'outra\n');
    await vi.waitFor(() => expect(dictionary.known('zebrinha')).toBe(false));
    expect(dictionary.known('outra')).toBe(true);
  });

  test('a união junta as duas camadas; a da pasta sai com a pasta', async () => {
    const { h, dictionary } = await started(
      { [`${DIR}/pessoal.txt`]: 'dapasta\n' },
      { 'pessoal.txt': 'global\n' },
    );
    expect([dictionary.known('dapasta'), dictionary.known('global')]).toEqual([true, true]);
    dictionary.close();
    expect([dictionary.known('dapasta'), dictionary.known('global')]).toEqual([false, true]);
    expect(dictionary.getSnapshot().folder).toEqual({ status: 'none', terms: [], warnings: [] });
    expect(h.dictionaries.calls().filter((c) => c.op === 'read')).toHaveLength(1);
  });
});

describe('AC-R32-1 (adicionar): a palavra vale em qualquer pasta aberta neste computador', () => {
  test('global: cria pessoal.txt, depois acrescenta com a base; vale na outra pasta; a da pasta não', async () => {
    const { h, dictionary } = await started({ 'outra/nota.md': '# Outra\n' });
    expect(await dictionary.add('excessão', 'global')).toEqual({ status: 'added' });
    expect(h.dictionaries.text('pessoal.txt')).toBe('excessão\n');
    expect(dictionary.known('Excessão')).toBe(true);
    expect(await dictionary.add('termodapasta', 'folder')).toEqual({ status: 'added' });
    expect(h.port.readText(`${DIR}/pessoal.txt`)).toBe('termodapasta\n');
    h.port.setPickDirectory(() => '/vault/outra');
    await h.app.sync.openVault('shell');
    await dictionary.ready();
    expect(h.app.store.getState().handle?.root).toBe('/vault/outra');
    expect([dictionary.known('excessão'), dictionary.known('termodapasta')]).toEqual([true, false]);
    expect(await dictionary.add('Brasil', 'global')).toEqual({ status: 'added' });
    expect(h.dictionaries.text('pessoal.txt')).toBe('excessão\nBrasil\n');
    expect(globalWrites(h).map((c) => [c.name, c.mode, c.outcome])).toEqual([
      ['pessoal.txt', 'create', 'ok'],
      ['pessoal.txt', 'overwrite', 'ok'],
    ]);
    // A pasta de origem continua com a palavra dela, só nela.
    expect(h.port.readText(`${DIR}/pessoal.txt`)).toBe('termodapasta\n');
    expect(h.port.readText(`outra/${DIR}/pessoal.txt`)).toBeNull();
  });

  test('acrescenta sem mexer no resto (comentários, sem `\\n` final); já existe → 0 gravações', async () => {
    const { h, dictionary } = await started(
      { [`${DIR}/pessoal.txt`]: '# da pasta\nexcessão' },
      { 'pessoal.txt': '# meu dicionário\r\nexcessão' },
    );
    expect(await dictionary.add('Outra', 'global')).toEqual({ status: 'added' });
    expect(await dictionary.add('Outra', 'folder')).toEqual({ status: 'added' });
    expect(h.dictionaries.text('pessoal.txt')).toBe('# meu dicionário\r\nexcessão\nOutra\n');
    expect(h.port.readText(`${DIR}/pessoal.txt`)).toBe('# da pasta\nexcessão\nOutra\n');
    const writes = h.writes();
    expect(await dictionary.add('excessão'.normalize('NFD'), 'folder')).toEqual({
      status: 'exists',
    });
    expect(await dictionary.add('Outra', 'global')).toEqual({ status: 'exists' });
    expect(h.writes()).toBe(writes);
    expect(globalWrites(h)).toHaveLength(1);
  });

  test('palavra fora do formato → invalid; camada da pasta sem pasta → no-folder', async () => {
    const h = await setup({}, { open: false });
    const { dictionary } = h.app;
    expect(await dictionary.add('duas palavras', 'global')).toEqual({ status: 'invalid' });
    expect(await dictionary.add('excessão', 'folder')).toEqual({ status: 'no-folder' });
    expect(await dictionary.remove('excessão', 'folder')).toEqual({ status: 'no-folder' });
    expect(globalWrites(h)).toEqual([]);
  });

  test('base velha (outro processo gravou): relê e tenta uma vez; na 2ª falha, erro sem perder nada', async () => {
    const { h, dictionary } = await started({}, { 'pessoal.txt': 'excessão\n' });
    h.dictionaries.put('pessoal.txt', 'excessão\nDeFora\n');
    expect(await dictionary.add('Nova', 'global')).toEqual({ status: 'added' });
    expect(h.dictionaries.text('pessoal.txt')).toBe('excessão\nDeFora\nNova\n');
    expect(dictionary.known('DeFora')).toBe(true);
    expect(globalWrites(h).map((c) => c.outcome)).toEqual(['CONFLICT', 'ok']);
    h.dictionaries.failNext('CONFLICT');
    h.dictionaries.failNext('CONFLICT');
    expect(await dictionary.add('Perdida', 'global')).toEqual({
      status: 'failed',
      message: 'Dicionário falso: CONFLICT',
    });
    expect(h.dictionaries.text('pessoal.txt')).toBe('excessão\nDeFora\nNova\n');
    expect(dictionary.known('Perdida')).toBe(false);
  });

  test('pasta: pessoal.txt mudou por fora antes da gravação → relê e acrescenta ao texto novo', async () => {
    const { h, dictionary } = await started({ [`${DIR}/pessoal.txt`]: 'excessão\n' });
    h.port.externalWrite(`${DIR}/pessoal.txt`, 'excessão\nDeFora\n');
    expect(await dictionary.add('Nova', 'folder')).toEqual({ status: 'added' });
    expect(h.port.readText(`${DIR}/pessoal.txt`)).toBe('excessão\nDeFora\nNova\n');
    expect(dictionary.known('DeFora')).toBe(true);
  });

  test('D-R32-6: remover tira o termo de todos os arquivos lidos da camada; os comentários ficam', async () => {
    const { h, dictionary } = await started(
      {
        [`${DIR}/pessoal.txt`]: 'excessão\n',
        [`${DIR}/clinica.txt`]: '# lista\r\nexcessão\r\nOutra\r\n',
      },
      { 'pessoal.txt': 'excessão\nOutra\n', 'clinica.txt': '# lista\nexcessão\n' },
    );
    expect(await dictionary.remove('Excessão', 'global')).toEqual({ status: 'absent' });
    expect(await dictionary.remove('excessão', 'global')).toEqual({ status: 'removed' });
    expect([h.dictionaries.text('pessoal.txt'), h.dictionaries.text('clinica.txt')]).toEqual([
      'Outra\n',
      '# lista\n',
    ]);
    expect(dictionary.known('excessão')).toBe(true); // ainda na camada da pasta
    expect(await dictionary.remove('excessão', 'folder')).toEqual({ status: 'removed' });
    expect(h.port.readText(`${DIR}/pessoal.txt`)).toBe('');
    expect(h.port.readText(`${DIR}/clinica.txt`)).toBe('# lista\r\nOutra\r\n');
    expect(dictionary.known('excessão')).toBe(false);
    expect(await dictionary.remove('excessão', 'global')).toEqual({ status: 'absent' });
  });
});

describe('AC-R32-3: tetos com aviso (D-R32-2) e erros de leitura', () => {
  test('200.001 termos numa camada: valem 200.000, 1 aviso (uma vez só); cheia → full', async () => {
    const words = Array.from({ length: DICTIONARY_LIMITS.layerMaxTerms + 1 }, (_, i) => `p${i}`);
    const { h, dictionary } = await started({}, { 'grande.txt': `${words.join('\n')}\n` });
    expect(dictionary.getSnapshot().global.terms).toHaveLength(200_000);
    expect([dictionary.known('p199999'), dictionary.known('p200000')]).toEqual([true, false]);
    const warnings = dictionary.takeWarnings();
    expect(warnings).toEqual([
      {
        id: 'global:terms',
        layer: 'global',
        text: 'o dicionário deste computador passa de 200.000 palavras: as que sobraram ficaram de fora.',
      },
    ]);
    expect(dictionary.takeWarnings()).toEqual([]);
    expect(await dictionary.add('nova', 'global')).toEqual({ status: 'full' });
    expect(globalWrites(h)).toEqual([]);
  });

  test('arquivo acima de 10 MiB: fica de fora, com aviso, sem ser lido (nas duas camadas)', async () => {
    const big = new Uint8Array(DICTIONARY_LIMITS.fileMaxBytes + 1).fill(0x61);
    const { h, dictionary } = await started(
      { [`${DIR}/enorme.txt`]: big, [`${DIR}/ok.txt`]: 'excessão\n' },
      { 'enorme.txt': big, 'ok.txt': 'Outra\n' },
    );
    expect([dictionary.known('excessão'), dictionary.known('Outra')]).toEqual([true, true]);
    expect(folderCalls(h, 'readFile').map((c) => c.abs.split('/').pop())).toEqual(['ok.txt']);
    expect(dictionary.takeWarnings().map((w) => [w.id, w.text])).toEqual([
      [
        'global:file:enorme.txt',
        'o arquivo “enorme.txt” do dicionário deste computador ficou de fora: passa de 10 MiB.',
      ],
      [
        'folder:file:enorme.txt',
        'o arquivo “enorme.txt” do dicionário desta pasta ficou de fora: passa de 10 MiB.',
      ],
    ]);
  });

  test('17 arquivos ou mais de 20 MiB na pasta: o excesso fica de fora, com aviso', async () => {
    const files: Record<string, string | Uint8Array> = {};
    for (let i = 0; i <= 16; i++) files[`${DIR}/a${String(i).padStart(2, '0')}.txt`] = `w${i}\n`;
    const many = await started(files);
    expect([many.dictionary.known('w15'), many.dictionary.known('w16')]).toEqual([true, false]);
    expect(many.dictionary.takeWarnings().map((w) => w.text)).toEqual([
      'o dicionário desta pasta passa de 16 arquivos ou 20 MiB: 1 arquivo ficou de fora.',
    ]);
    const chunk = (word: string) => `${word}\n${'#'.repeat(8 * MIB)}\n`;
    const heavy = await started({
      [`${DIR}/a.txt`]: chunk('um'),
      [`${DIR}/b.txt`]: chunk('dois'),
      [`${DIR}/c.txt`]: chunk('tres'),
    });
    expect(['um', 'dois', 'tres'].map((w) => heavy.dictionary.known(w))).toEqual([
      true,
      true,
      false,
    ]);
    expect(folderCalls(heavy.h, 'readFile').map((c) => c.abs.split('/').pop())).toEqual([
      'a.txt',
      'b.txt',
    ]);
    expect(heavy.dictionary.takeWarnings().map((w) => w.id)).toEqual(['folder:skipped']);
  });

  test('pessoal.txt passaria de 10 MiB → full, sem gravar', async () => {
    const { h, dictionary } = await started(
      {},
      // 10 MiB − 8 bytes: "abc\n" (4) cabe; depois "abcd\n" (5) passaria de 10 MiB.
      { 'pessoal.txt': `${'#'.repeat(DICTIONARY_LIMITS.fileMaxBytes - 9)}\n` },
    );
    expect(await dictionary.add('abc', 'global')).toEqual({ status: 'added' });
    expect(await dictionary.add('abcd', 'global')).toEqual({ status: 'full' });
    expect(h.dictionaries.text('pessoal.txt')?.endsWith('\nabc\n')).toBe(true);
  });

  test('link, não UTF-8 e pessoal.txt ilegível: de fora, com aviso; "Adicionar" diz por quê', async () => {
    const h = await setup({
      'nota.md': '# Nota\n',
      [`${DIR}/pessoal.txt`]: new Uint8Array([0x65, 0xff, 0x0a]),
    });
    h.port.symlink(`${DIR}/link.txt`, '/fora.txt');
    const { dictionary } = h.app;
    dictionary.subscribe(() => {});
    await dictionary.ready();
    expect(dictionary.takeWarnings().map((w) => w.text)).toEqual([
      'o arquivo “pessoal.txt” do dicionário desta pasta ficou de fora: não está em UTF-8.',
      'o arquivo “link.txt” do dicionário desta pasta ficou de fora: é um link.',
    ]);
    expect(await dictionary.add('excessão', 'folder')).toEqual({
      status: 'failed',
      message: 'o pessoal.txt não está em UTF-8',
    });
  });

  test('aviso volta só se a causa sumir e reaparecer', async () => {
    const { h, dictionary } = await started({ [`${DIR}/ruim.txt`]: new Uint8Array([0xff]) });
    expect(dictionary.takeWarnings().map((w) => w.id)).toEqual(['folder:file:ruim.txt']);
    h.port.externalWrite(`${DIR}/ruim.txt`, new Uint8Array([0xfe]));
    await vi.waitFor(() => expect(folderCalls(h, 'readFile')).toHaveLength(2));
    await dictionary.ready();
    expect(dictionary.takeWarnings()).toEqual([]);
    h.port.externalWrite(`${DIR}/ruim.txt`, 'boa\n');
    await vi.waitFor(() => expect(dictionary.known('boa')).toBe(true));
    h.port.externalWrite(`${DIR}/ruim.txt`, new Uint8Array([0xff]));
    await vi.waitFor(() => expect(dictionary.known('boa')).toBe(false));
    expect(dictionary.takeWarnings().map((w) => w.id)).toEqual(['folder:file:ruim.txt']);
  });

  test('a leitura da camada global falha: aviso; "Adicionar" relê antes de gravar', async () => {
    const h = await setup({ 'nota.md': '# Nota\n' });
    h.dictionaries.failNext('IO', 'read');
    const { dictionary } = h.app;
    dictionary.subscribe(() => {});
    await dictionary.ready();
    expect(dictionary.getSnapshot().global.status).toBe('error');
    expect(dictionary.takeWarnings().map((w) => w.text)).toEqual([
      'não foi possível ler o dicionário deste computador (IO).',
    ]);
    expect(await dictionary.add('excessão', 'global')).toEqual({ status: 'added' });
    expect(dictionary.getSnapshot().global).toEqual({
      status: 'ready',
      terms: ['excessão'],
      warnings: [],
    });
  });
});
