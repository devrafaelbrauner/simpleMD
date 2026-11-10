import { createHash } from 'node:crypto';
import { VAULT_READ_LIMITS } from '@simplemd/themes';
import { LocalFsProvider } from '@simplemd/vault';
import { MEMORY_ROOT, MemoryFsPort } from '@simplemd/vault/testing';
import { describe, expect, test, vi } from 'vitest';
import {
  createHarnessDictionaries,
  dicWord,
  importLine,
  slugOf,
  type HarnessImportPick,
} from '../harness/dictionaries';
import {
  DICTIONARY_LIMITS,
  DictionaryService,
  FOLDER_DICTIONARY_DIR,
  dictionaryErrorMessage,
  importSummary,
  inDictionary,
  isDictionaryName,
  listFileName,
  normalizeWord,
  parseWordList,
} from '../src/state/dictionary';
import { createAppStore } from '../src/state/store';
import { systemClock } from '../src/state/sync';
import { setup, type Harness } from './helpers';

// O sha256 puro-JS (@noble/hashes) fica ~13× mais lento sob a cobertura v8 do CI: os hashes de
// 7–10 MiB de "pessoal.txt passaria de 10 MiB" e "17 arquivos ou mais de 20 MiB" levavam de 4,8 a
// mais de 5 s no Linux (r32b, r32d). Mesmo digest (ver content-base.test.ts), calculado em C++ pelo
// Node; a gravação condicional não muda. O mock do módulo alcança `@simplemd/vault` e o provider.
vi.mock('../../../packages/vault/src/hash', () => ({
  sha256Hex: (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex'),
}));

/**
 * r32b — dicionário do usuário no app (design-r32 §1, §5; D-R32-1..6): o formato v1 (vetores que a
 * r33 repete no Rust), a regra de caixa que saiu do LanguageTool, as camadas global (falso
 * `h.dictionaries`, a semântica dos comandos Rust) e da pasta (vault em memória), a união, a
 * gravação condicional, os tetos e os avisos (r35b: na área de avisos do app, D-R32-7).
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
/** Os avisos de teto das camadas no app (D-R32-7): `[texto]` ou `[texto, detalhe]`. */
const limitNotices = (h: Harness) =>
  h.app.store
    .getState()
    .notices.filter((n) => n.notice === 'dictionary-limit')
    .map((n) => (n.detail === undefined ? [n.text] : [n.text, n.detail]));

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
    const { h, dictionary } = await started({
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
    expect(limitNotices(h)).toEqual([]);
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
    expect(dictionary.getSnapshot().folder).toEqual({
      status: 'none',
      terms: [],
      warnings: [],
      files: [],
    });
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
  test('200.001 termos numa camada: valem 200.000 e o app avisa uma vez só (D-R32-7); cheia → full', async () => {
    const words = Array.from({ length: DICTIONARY_LIMITS.layerMaxTerms + 1 }, (_, i) => `p${i}`);
    const { h, dictionary } = await started(
      { 'outra/nota.md': '# Outra\n' },
      { 'grande.txt': `${words.join('\n')}\n` },
    );
    expect(dictionary.getSnapshot().global.terms).toHaveLength(200_000);
    expect([dictionary.known('p199999'), dictionary.known('p200000')]).toEqual([true, false]);
    expect(dictionary.getSnapshot().global.warnings).toEqual([
      {
        id: 'global:terms',
        layer: 'global',
        reason: 'terms',
        text: 'o dicionário deste computador passa de 200.000 palavras: as que sobraram ficaram de fora.',
      },
    ]);
    expect(limitNotices(h)).toEqual([
      ['O dicionário deste computador passa de 200.000 palavras: as que sobraram ficaram de fora.'],
    ]);
    expect(
      h.app.store.getState().notices.find((n) => n.notice === 'dictionary-limit'),
    ).toMatchObject({ kind: 'info', level: 'warn' });
    // A camada global é relida a cada pasta aberta: a mesma causa não avisa de novo.
    h.port.setPickDirectory(() => '/vault/outra');
    await h.app.sync.openVault('shell');
    await dictionary.ready();
    expect(h.dictionaries.calls().filter((c) => c.op === 'read')).toHaveLength(2);
    expect(limitNotices(h)).toHaveLength(1);
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
    const { global, folder } = dictionary.getSnapshot();
    expect([...global.warnings, ...folder.warnings].map((w) => w.id)).toEqual([
      'global:file:enorme.txt',
      'folder:file:enorme.txt',
    ]);
    // Um aviso por camada; a ordem é a de chegada das leituras.
    expect(limitNotices(h).sort()).toEqual([
      ['O arquivo “enorme.txt” do dicionário desta pasta ficou de fora: passa de 10 MiB.'],
      ['O arquivo “enorme.txt” do dicionário deste computador ficou de fora: passa de 10 MiB.'],
    ]);
  });

  test('17 arquivos ou mais de 20 MiB na pasta: o excesso fica de fora, com aviso', async () => {
    const files: Record<string, string | Uint8Array> = {};
    for (let i = 0; i <= 16; i++) files[`${DIR}/a${String(i).padStart(2, '0')}.txt`] = `w${i}\n`;
    const many = await started(files);
    expect([many.dictionary.known('w15'), many.dictionary.known('w16')]).toEqual([true, false]);
    expect(limitNotices(many.h)).toEqual([
      ['O dicionário desta pasta passa de 16 arquivos ou 20 MiB: 1 arquivo ficou de fora.'],
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
    expect(heavy.dictionary.getSnapshot().folder.warnings.map((w) => w.id)).toEqual([
      'folder:skipped',
    ]);
    expect(limitNotices(heavy.h)).toHaveLength(1);
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

  test('link, não UTF-8 e pessoal.txt ilegível: de fora, com um aviso só (o motivo é o mesmo); "Adicionar" diz por quê', async () => {
    const h = await setup({
      'nota.md': '# Nota\n',
      [`${DIR}/pessoal.txt`]: new Uint8Array([0x65, 0xff, 0x0a]),
    });
    h.port.symlink(`${DIR}/link.txt`, '/fora.txt');
    const { dictionary } = h.app;
    dictionary.subscribe(() => {});
    await dictionary.ready();
    expect(limitNotices(h)).toEqual([
      [
        'O arquivo “pessoal.txt” do dicionário desta pasta ficou de fora: não está em UTF-8.',
        'O arquivo “link.txt” do dicionário desta pasta ficou de fora: é um link.',
      ],
    ]);
    expect(await dictionary.add('excessão', 'folder')).toEqual({
      status: 'failed',
      message: 'o pessoal.txt não está em UTF-8',
    });
  });

  test('D-R32-7: um aviso por camada e motivo na sessão — a causa que volta, outro arquivo e outra pasta não repetem', async () => {
    const { h, dictionary } = await started({
      [`${DIR}/ruim.txt`]: new Uint8Array([0xff]),
      [`outra/${DIR}/estragado.txt`]: new Uint8Array([0xfe]),
    });
    const first =
      'O arquivo “ruim.txt” do dicionário desta pasta ficou de fora: não está em UTF-8.';
    expect(limitNotices(h)).toEqual([[first]]);
    h.port.externalWrite(`${DIR}/ruim.txt`, 'boa\n');
    await vi.waitFor(() => expect(dictionary.known('boa')).toBe(true));
    h.port.externalWrite(`${DIR}/ruim.txt`, new Uint8Array([0xff]));
    await vi.waitFor(() => expect(dictionary.known('boa')).toBe(false));
    h.port.externalWrite(`${DIR}/outro.txt`, new Uint8Array([0xfe]));
    await vi.waitFor(() => expect(dictionary.getSnapshot().folder.warnings).toHaveLength(2));
    expect(limitNotices(h)).toEqual([[first]]);
    // Outra pasta com o mesmo motivo, na mesma sessão: a lista das Configurações mostra o aviso.
    h.port.setPickDirectory(() => '/vault/outra');
    await h.app.sync.openVault('shell');
    await dictionary.ready();
    expect(dictionary.getSnapshot().folder.warnings.map((w) => w.id)).toEqual([
      'folder:file:estragado.txt',
    ]);
    expect(limitNotices(h)).toEqual([[first]]);
    // Outra camada, outro aviso.
    h.dictionaries.put('enorme.txt', new Uint8Array(DICTIONARY_LIMITS.fileMaxBytes + 1).fill(0x61));
    expect(await dictionary.remove('nada', 'global')).toEqual({ status: 'absent' });
    expect(limitNotices(h)).toEqual([
      [first],
      ['O arquivo “enorme.txt” do dicionário deste computador ficou de fora: passa de 10 MiB.'],
    ]);
  });

  test('a leitura da camada global falha: aviso; "Adicionar" relê antes de gravar', async () => {
    const h = await setup({ 'nota.md': '# Nota\n' });
    h.dictionaries.failNext('IO', 'read');
    const { dictionary } = h.app;
    dictionary.subscribe(() => {});
    await dictionary.ready();
    expect(dictionary.getSnapshot().global.status).toBe('error');
    expect(limitNotices(h)).toEqual([['Não foi possível ler o dicionário deste computador (IO).']]);
    expect(await dictionary.add('excessão', 'global')).toEqual({ status: 'added' });
    expect(dictionary.getSnapshot().global).toEqual({
      status: 'ready',
      terms: ['excessão'],
      warnings: [],
      files: [],
    });
  });
});

/** r33a: o serviço com o falso ligado à pasta em memória (importar "pelo Rust" em "Esta pasta"). */
async function withFolder(files: Record<string, string | Uint8Array> = {}) {
  const port = new MemoryFsPort();
  port.seed({ 'nota.md': '# Nota\n', ...files });
  const vault = new LocalFsProvider(port, { readLimits: VAULT_READ_LIMITS });
  const fake = createHarnessDictionaries({ folder: { port: () => port, root: () => MEMORY_ROOT } });
  const dictionary = new DictionaryService({
    port: fake.dictionaries,
    vault,
    clock: systemClock,
    store: createAppStore(),
  });
  const handle = await vault.open();
  vault.activate(handle);
  dictionary.open(handle);
  dictionary.subscribe(() => {});
  await dictionary.ready();
  return { port, fake: fake.control, dictionary };
}

describe('r33a: a regra de nomes do Rust no TS (r36a, N1; AppSec r36a N2)', () => {
  test('isDictionaryName aceita e recusa como `policy::dictionary_name` (os vetores de policy.rs)', () => {
    const ok = [
      'pessoal.txt',
      'médicos.txt',
      'Lista Antiga.TXT',
      'a.txt',
      'com0.txt',
      `${'a'.repeat(1020)}.txt`,
      'com10.txt',
      'lpt.txt',
      'conin.txt',
      'console.txt',
      'contas .txt',
      'nul-x.txt',
      'a b.txt',
      '日記.txt',
      'caf\u00e9.txt',
      'cafe\u0301.txt',
      'pesso\u0430l.txt',
      '한국어.txt',
      '\u2764.txt',
    ];
    const bad = [
      '',
      '.txt',
      'pessoal',
      'pessoal.md',
      'pessoal.txt.md',
      'a/b.txt',
      '../fora.txt',
      '..',
      '/etc/x.txt',
      '~/x.txt',
      'C:x.txt',
      '.oculto.txt',
      '.~simplemd-0123456789abcdef.tmp',
      '.simplemd',
      '.markdownlint.json',
      'a\\b.txt',
      'x:y.txt',
      'x.txt ',
      'x.txt.',
      'con.txt',
      'LPT1.txt',
      'x\n.txt',
      'x\u0000.txt',
      `${'a'.repeat(1021)}.txt`,
      'a\u0080.txt',
      'a\u0085b.txt',
      '\u009fx.txt',
      'abc\u202etxt.exe.txt',
      'a\u2066b\u2069.txt',
      'a\u200f.txt',
      'a\u061c.txt',
      'a\u200bb.txt',
      'a\u200db.txt',
      'a\u2060b.txt',
      '\ufeffpessoal.txt',
      'a\u00adb.txt',
      'COM¹.txt',
      'com².txt',
      'lpt³.txt',
      'LPT¹.txt',
      'CONIN$.txt',
      'conout$.txt',
      'con .txt',
      'NUL  .txt',
      'aux .txt',
      'com1 .txt',
      'lpt² .txt',
      'conin$ .txt',
      'pessoal\u034f.txt',
      'pessoal\ufe00.txt',
      'pessoal\ufe0f.txt',
      'pessoal\u{e0100}.txt',
      'pessoal\u{e01ef}.txt',
      'pessoal\u180b.txt',
      'pessoal\u180f.txt',
      '\u115fpessoal.txt',
      'pessoal\u1160.txt',
      'pessoal\u3164.txt',
      'pessoal\uffa0.txt',
      'pessoal\u2800.txt',
      'pessoal\u2028x.txt',
      'pessoal\u2029x.txt',
      'pessoal\u00a0.txt',
      'a\u1680b.txt',
      'a\u2000b.txt',
      'a\u200ab.txt',
      'a\u202fb.txt',
      'a\u205fb.txt',
      'a\u3000b.txt',
    ];
    expect(ok.filter((name) => !isDictionaryName(name))).toEqual([]);
    expect(bad.filter((name) => isDictionaryName(name))).toEqual([]);
  });

  test('listFileName: o nome digitado sem espaços nas pontas e sem o .txt, em NFC; fora da regra → null', () => {
    expect(listFileName('  Cardiologia  ')).toBe('Cardiologia.txt');
    expect(listFileName('cardio.TXT')).toBe('cardio.txt');
    expect(listFileName('cafe\u0301')).toBe('caf\u00e9.txt');
    for (const typed of ['', '   ', 'a/b', 'con', 'x\u202e', '.oculto', 'a\u00a0b', 'com¹'])
      expect(listFileName(typed), typed).toBeNull();
  });

  test('a camada lida pelo app ignora o que o Rust não lista (bidi, dispositivo, N1)', async () => {
    const { dictionary } = await started({
      [`${DIR}/boa.txt`]: 'vale\n',
      [`${DIR}/con .txt`]: 'naoconta\n',
      [`${DIR}/pessoal\u00a0.txt`]: 'naoconta\n',
      [`${DIR}/x\u2800.txt`]: 'naoconta\n',
    });
    expect(dictionary.getSnapshot().folder.terms).toEqual(['vale']);
    expect(dictionary.getSnapshot().folder.files).toEqual([{ name: 'boa.txt', words: 1 }]);
  });
});

describe('r33a: o falso importa com as regras do Rust (os vetores de import.rs)', () => {
  test('termo v1 sem NFC (e o leitor do app concorda), palavra de uma linha de .dic e slug', () => {
    const [a64, a65, e64, e65] = ['a'.repeat(64), 'a'.repeat(65), '😀'.repeat(64), '😀'.repeat(65)];
    const words: Array<[string, string]> = [
      ['excessão', 'excessão'],
      ['  excessão \r', 'excessão'],
      ['\uFEFFexcessão\uFEFF', 'excessão'],
      [a64, a64],
      [e64, e64],
      ['e-mail', 'e-mail'],
      ['a/b', 'a/b'],
      ['C++', 'C++'],
      ['\u201Caspas\u201D', '\u201Caspas\u201D'],
    ];
    for (const [raw, term] of words) {
      expect(importLine(raw), raw).toEqual({ term });
      expect(normalizeWord(raw), raw).toBe(term);
    }
    const invalid = [
      'duas palavras',
      'tab\tdentro',
      'sem\u00a0quebra',
      'sino\u0007',
      'bidi\u202eabc',
      'largura\u200bzero',
      'hífen\u00admole',
      a65,
      e65,
      '\u0085x',
      'x\u2028y',
    ];
    expect(invalid.map(importLine)).toEqual(invalid.map(() => 'invalid'));
    expect(invalid.map(normalizeWord)).toEqual(invalid.map(() => null));
    const skip = ['', '   ', '\r', '# comentário', '#hashtag', '  #x'];
    expect(skip.map(importLine)).toEqual(skip.map(() => 'skip'));
    const lines: Array<[string, string]> = [
      ['abacaxi/S', 'abacaxi'],
      ['maçã/SM', 'maçã'],
      ['a\\/b/X', 'a/b'],
      ['palavra\tpo:subst', 'palavra'],
      ['casa po:subst st:casa', 'casa'],
      ['Rio de Janeiro', 'Rio de Janeiro'],
      ['/SOFLAG', ''],
      ['x\\', 'x\\'],
      ['e-mail/S', 'e-mail'],
      ['ab po', 'ab po'],
      ['ab Po:x', 'ab Po:x'],
    ];
    expect(lines.map(([line]) => dicWord(line))).toEqual(lines.map(([, word]) => word));
    const slugs: Array<[string, string]> = [
      ['Termos Médicos.txt', 'termos-medicos'],
      ['pt_BR.dic', 'pt_br'],
      ['CON.txt', 'importado'],
      ['com1.dic', 'importado'],
      ['pessoal.txt', 'pessoal-importado'],
      ['PESSOAL.dic', 'pessoal-importado'],
      ['日本語.txt', 'importado'],
      ['  --Lista  Nova--  .txt', 'lista-nova'],
      ['Ação & Reação.dic', 'acao-reacao'],
      ['Œuvre Straße.txt', 'oeuvre-strasse'],
      ['cafe\u0301.txt', 'cafe'],
      ['lista.v2.txt', 'lista-v2'],
      ['termos_médicos 2026.txt', 'termos_medicos-2026'],
      ['nul-x.txt', 'nul-x'],
      ['.txt', 'txt'],
      [`${'a'.repeat(60)}.txt`, 'a'.repeat(48)],
      [`${'a'.repeat(47)}-b.txt`, 'a'.repeat(47)],
    ];
    expect(slugs.map(([name]) => slugOf(name))).toEqual(slugs.map(([, slug]) => slug));
  });

  test('recusa como o Rust: link (também o .aff), NUL, sem termo, outra extensão, SET desconhecido, UTF-8 inválido declarado', async () => {
    const { h, dictionary } = await started();
    const picks: HarnessImportPick[] = [
      { fileName: 'a.txt', bytes: 'x\n', link: 'file' },
      { fileName: 'a.dic', bytes: '1\nx\n', aff: 'SET UTF-8\n', link: 'aff' },
      { fileName: 'a.txt', bytes: new Uint8Array([0x61, 0x00, 0x62]) },
      { fileName: 'a.txt', bytes: '# só comentário\n\n' },
      { fileName: 'a.md', bytes: 'x\n' },
      { fileName: 'a.dic', bytes: '1\nx\n', aff: 'SET KOI8-R\n' },
      { fileName: 'a.dic', bytes: new Uint8Array([0x31, 0x0a, 0xe9, 0x0a]), aff: 'SET UTF-8\n' },
      { error: 'IO' },
    ];
    const codes: string[] = [];
    for (const pick of picks) {
      h.dictionaries.importNext(pick);
      const result = await dictionary.import('global');
      codes.push(result.status === 'failed' ? result.code : result.status);
    }
    expect(codes).toEqual([
      'SYMLINK',
      'SYMLINK',
      'NOT_TEXT',
      'EMPTY',
      'UNSUPPORTED_TYPE',
      'UNSUPPORTED_ENCODING',
      'BAD_ENCODING',
      'IO',
    ]);
    expect(h.dictionaries.names()).toEqual([]);
  });
});

describe('AC-R33-1 (serviço): importar uma lista de termos', () => {
  test('termos-medicos.txt com 50.000 termos tira "colecistectomia" do filtro do LanguageTool (`known`)', async () => {
    const { h, dictionary, changes } = await started();
    // O plugin descarta o erro de ortografia de uma palavra conhecida (`known`, o filtro do LT).
    expect(dictionary.known('colecistectomia')).toBe(false);
    const before = changes.mock.calls.length;
    expect(await dictionary.import('global')).toEqual({
      status: 'imported',
      name: 'termos-medicos.txt',
      words: 50_000,
      discarded: 0,
      encoding: 'UTF-8',
      pair: false,
      summary: '“termos-medicos” importado: 50.000 palavras (lido como UTF-8).',
    });
    expect(
      ['colecistectomia', 'Colecistectomia', 'COLECISTECTOMIA'].map((w) => dictionary.known(w)),
    ).toEqual([true, true, true]);
    expect(dictionary.getSnapshot().global.terms).toHaveLength(50_000);
    expect(dictionary.getSnapshot().global.files).toEqual([
      { name: 'termos-medicos.txt', words: 50_000 },
    ]);
    expect(changes.mock.calls.length).toBeGreaterThan(before);
    expect(h.dictionaries.calls().filter((c) => c.op === 'import')).toEqual([
      { op: 'import', layer: 'global', name: 'termos-medicos.txt', words: 50_000, outcome: 'ok' },
    ]);
    expect(h.dictionaries.text('termos-medicos.txt')?.split('\n')[0]).toMatch(
      /^# Importado de termos-medicos\.txt em \d{4}-\d{2}-\d{2}$/,
    );
  });

  test('cancelar não muda nada; "Esta pasta" sem pasta nem abre o diálogo', async () => {
    const { h, dictionary } = await started({}, { 'pessoal.txt': 'excessão\n' });
    const reads = h.dictionaries.calls().filter((c) => c.op === 'read').length;
    h.dictionaries.importNext('cancel');
    expect(await dictionary.import('global')).toEqual({ status: 'cancelled' });
    expect(h.dictionaries.names()).toEqual(['pessoal.txt']);
    expect(h.dictionaries.calls().filter((c) => c.op === 'read')).toHaveLength(reads);
    const closed = await setup({}, { open: false });
    expect(await closed.app.dictionary.import('folder')).toEqual({ status: 'no-folder' });
    expect(closed.dictionaries.calls().filter((c) => c.op === 'import')).toEqual([]);
  });

  test('uma importação por vez: a segunda, durante a primeira → BUSY', async () => {
    const { dictionary } = await started();
    const [first, second] = await Promise.all([
      dictionary.import('global'),
      dictionary.import('global'),
    ]);
    expect(first).toMatchObject({ status: 'imported', name: 'termos-medicos.txt' });
    expect(second).toEqual({
      status: 'failed',
      code: 'BUSY',
      message: 'Já há uma importação em andamento.',
    });
  });

  test('a camada cheia (16 listas) recusa com a mensagem dela; nada é gravado', async () => {
    const global: Record<string, string> = {};
    for (let i = 0; i < 16; i++) global[`l${String(i).padStart(2, '0')}.txt`] = `t${i}\n`;
    const { h, dictionary } = await started({}, global);
    h.dictionaries.importNext({ fileName: 'nova.txt', bytes: 'nova\n' });
    expect(await dictionary.import('global')).toEqual({
      status: 'failed',
      code: 'LAYER_FULL',
      message:
        'O dicionário deste computador chegou a um limite (16 listas, 200.000 palavras ou 20 MB); remova uma lista antes de importar.',
    });
    expect(h.dictionaries.names()).toHaveLength(16);
  });
});

describe('AC-R33-2 (serviço): Hunspell latin-1 com flags e o teto de 10 MiB', () => {
  test('.dic com flags e .aff SET ISO8859-1 → palavras certas, "lido como ISO-8859-1" e o par guardado', async () => {
    const { h, dictionary } = await started();
    const dic = Uint8Array.from(
      '4\nma\xe7\xe3/S\ncora\xe7\xe3o/SM\npalavra\tpo:subst\n/SOFLAG\n',
      (c) => c.charCodeAt(0),
    );
    const aff = 'SET ISO8859-1\nSFX S Y 1\nSFX S 0 s .\n';
    h.dictionaries.importNext({ fileName: 'pt_BR.dic', bytes: dic, aff });
    expect(await dictionary.import('global')).toEqual({
      status: 'imported',
      name: 'pt_br.txt',
      words: 3,
      discarded: 1,
      encoding: 'ISO-8859-1',
      pair: true,
      summary: '“pt_br” importado: 3 palavras, 1 descartada (lido como ISO-8859-1).',
    });
    expect(['maçã', 'Coração', 'palavra'].map((w) => dictionary.known(w))).toEqual([
      true,
      true,
      true,
    ]);
    expect(h.dictionaries.bytes('hunspell/pt_br.dic')).toEqual(dic);
    expect(h.dictionaries.text('hunspell/pt_br.aff')).toBe(aff);
    expect(dictionary.getSnapshot().global.files).toEqual([{ name: 'pt_br.txt', words: 3 }]);
  });

  test('acima de 10 MiB → recusado com a mensagem do limite, nada gravado', async () => {
    const { h, dictionary } = await started();
    const big = new Uint8Array(DICTIONARY_LIMITS.fileMaxBytes + 1).fill(0x61);
    h.dictionaries.importNext({ fileName: 'enorme.txt', bytes: big });
    expect(await dictionary.import('global')).toEqual({
      status: 'failed',
      code: 'TOO_LARGE',
      message: '“enorme.txt” tem 10,1 MB; o limite é 10 MB.',
    });
    expect(h.dictionaries.names()).toEqual([]);
  });
});

describe('r33a: listas — "Esta pasta", renomear, remover e o reset do harness', () => {
  test('na pasta: a lista e o par vão para .simplemd/dictionaries; renomear (NFC) e remover levam o par', async () => {
    const { port, fake, dictionary } = await withFolder({ [`${DIR}/pessoal.txt`]: 'meu\n' });
    fake.importNext({
      fileName: 'Cardiologia.dic',
      bytes: '2\nmiocardio/S\nstent\n',
      aff: 'SET UTF-8\n',
    });
    expect(await dictionary.import('folder')).toMatchObject({
      status: 'imported',
      name: 'cardiologia.txt',
      words: 2,
      pair: true,
    });
    expect(dictionary.known('stent')).toBe(true);
    expect(port.readText(`${DIR}/hunspell/cardiologia.dic`)).toBe('2\nmiocardio/S\nstent\n');
    expect(dictionary.getSnapshot().folder.files).toEqual([{ name: 'cardiologia.txt', words: 2 }]);
    const typed = `  ${'coração'.normalize('NFD')}  `;
    expect(await dictionary.rename('folder', 'cardiologia.txt', typed)).toEqual({
      status: 'renamed',
      name: 'coração.txt',
    });
    expect(port.readText(`${DIR}/cardiologia.txt`)).toBeNull();
    expect(port.readText(`${DIR}/coração.txt`)?.endsWith('\nmiocardio\nstent\n')).toBe(true);
    expect(port.readText(`${DIR}/hunspell/coração.dic`)).toBe('2\nmiocardio/S\nstent\n');
    expect(port.readText(`${DIR}/hunspell/coração.aff`)).toBe('SET UTF-8\n');
    expect(dictionary.getSnapshot().folder.files).toEqual([{ name: 'coração.txt', words: 2 }]);
    expect(await dictionary.removeList('folder', 'coração.txt')).toEqual({ status: 'removed' });
    expect(
      ['coração.txt', 'hunspell/coração.dic', 'hunspell/coração.aff'].map((rel) =>
        port.readBytes(`${DIR}/${rel}`),
      ),
    ).toEqual([null, null, null]);
    expect(dictionary.known('stent')).toBe(false);
    expect(port.readText(`${DIR}/pessoal.txt`)).toBe('meu\n');
    expect(fake.calls().map((c) => [c.op, c.action ?? c.layer, c.outcome])).toEqual([
      ['read', undefined, 'ok'],
      ['import', 'folder', 'ok'],
      ['manage', 'rename', 'ok'],
      ['manage', 'remove', 'ok'],
    ]);
  });

  test('pessoal.txt protegido e nome fora da regra recusados antes do Rust; colisão e sumiço com mensagem', async () => {
    const { h, dictionary } = await started(
      {},
      { 'pessoal.txt': 'meu\n', 'a.txt': 'um\n', 'b.txt': 'dois\n' },
    );
    const manage = () => h.dictionaries.calls().filter((c) => c.op === 'manage');
    expect(await dictionary.removeList('global', 'pessoal.txt')).toEqual({
      status: 'failed',
      code: 'PROTECTED',
      message: 'O pessoal.txt não pode ser renomeado nem removido.',
    });
    for (const name of ['PESSOAL.TXT', 'peſsoal.txt', 'PEſSOAL.txt', 'PEẞOAL.TXT'])
      expect(await dictionary.removeList('global', name), name).toMatchObject({
        code: 'PROTECTED',
      });
    for (const typed of ['Pessoal', 'peſsoal', 'PESSOAL.TXT', 'PEẞOAL'])
      expect(await dictionary.rename('global', 'a.txt', typed), typed).toEqual({
        status: 'failed',
        code: 'PROTECTED',
        message: '“pessoal” é o nome do dicionário pessoal; escolha outro nome.',
      });
    expect(await dictionary.rename('global', 'peſsoal.txt', 'b2')).toMatchObject({
      code: 'PROTECTED',
      message: 'O pessoal.txt não pode ser renomeado nem removido.',
    });
    for (const typed of ['a/b', 'con', 'x\u202e', ''])
      expect(await dictionary.rename('global', 'a.txt', typed), typed).toMatchObject({
        status: 'failed',
        code: 'INVALID_NAME',
      });
    expect(await dictionary.removeList('global', 'con .txt')).toMatchObject({
      code: 'INVALID_NAME',
    });
    expect(manage()).toEqual([]);
    expect(await dictionary.rename('global', 'a.txt', 'b')).toEqual({
      status: 'failed',
      code: 'ALREADY_EXISTS',
      message: 'Já existe uma lista com esse nome.',
    });
    expect(await dictionary.rename('global', 'a.txt', 'a')).toEqual({
      status: 'renamed',
      name: 'a.txt',
    });
    expect(await dictionary.removeList('global', 'nada.txt')).toMatchObject({ code: 'NOT_FOUND' });
    expect(manage().map((c) => [c.action, c.outcome])).toEqual([
      ['rename', 'ALREADY_EXISTS'],
      ['remove', 'NOT_FOUND'],
    ]);
    expect(h.dictionaries.names().sort()).toEqual(['a.txt', 'b.txt', 'pessoal.txt']);
    expect(dictionary.getSnapshot().global.files).toEqual([
      { name: 'a.txt', words: 1 },
      { name: 'b.txt', words: 1 },
    ]);
  });

  test('o falso como o Rust (review r33a c1): PEẞOAL.TXT é o pessoal.txt (NB-3); renomear para b.TXT cria b.txt sem sobrescrever o b.TXT (NB-1)', async () => {
    const { dictionaries, control } = createHarnessDictionaries();
    control.put('pessoal.txt', 'meu\n');
    control.put('a.txt', 'A\n');
    control.put('b.TXT', 'B\n');
    await expect(dictionaries.remove('global', 'PEẞOAL.TXT')).rejects.toMatchObject({
      code: 'PROTECTED',
    });
    await expect(dictionaries.rename('global', 'a.txt', 'PEẞOAL.TXT')).rejects.toMatchObject({
      code: 'PROTECTED',
    });
    await dictionaries.rename('global', 'a.txt', 'b.TXT');
    expect(control.names().sort()).toEqual(['b.TXT', 'b.txt', 'pessoal.txt']);
    expect([control.text('b.TXT'), control.text('b.txt'), control.text('pessoal.txt')]).toEqual([
      'B\n',
      'A\n',
      'meu\n',
    ]);
  });

  test('N3 (r32c): dictionaries.reset() do harness esvazia a camada global também no app', async () => {
    const { h, dictionary } = await started(
      {},
      { 'pessoal.txt': 'excessão\n', 'termos.txt': 'clínica\n' },
    );
    expect(dictionary.known('excessão')).toBe(true);
    h.dictionaries.reset();
    await vi.waitFor(() =>
      expect(dictionary.getSnapshot().global).toEqual({
        status: 'ready',
        terms: [],
        warnings: [],
        files: [],
      }),
    );
    expect([dictionary.known('excessão'), dictionary.known('clínica')]).toEqual([false, false]);
    expect(h.dictionaries.names()).toEqual([]);
  });

  test('mensagens pelo código: sem caminho, com o nome e a codificação do arquivo só como texto', () => {
    expect(
      dictionaryErrorMessage('TOO_LARGE', {
        fileName: 'a\u202e.txt',
        size: 12 * MIB,
        max: 10 * MIB,
      }),
    ).toBe('“a\uFFFD.txt” tem 12 MB; o limite é 10 MB.');
    expect(dictionaryErrorMessage('UNSUPPORTED_ENCODING', { encoding: 'KOI8-R' })).toBe(
      'A codificação “KOI8-R” declarada no .aff não é suportada (use UTF-8, ISO8859-1, ISO8859-15 ou microsoft-cp1252).',
    );
    expect(dictionaryErrorMessage('BAD_ENCODING', { encoding: 'ISO-8859-1' })).toBe(
      'O arquivo não está em ISO-8859-1, a codificação declarada.',
    );
    expect(dictionaryErrorMessage('LAYER_FULL', undefined, 'folder')).toMatch(
      /^O dicionário desta pasta chegou a um limite/,
    );
    const codes = [
      'BUSY',
      'SYMLINK',
      'UNSUPPORTED_TYPE',
      'NOT_TEXT',
      'EMPTY',
      'ALREADY_EXISTS',
      'NOT_FOUND',
      'PROTECTED',
      'INVALID_NAME',
      'NO_VAULT',
      'VAULT_CLOSED',
      'OUTSIDE_VAULT',
      'PERMISSION_DENIED',
      'INVALID_PATH',
    ];
    expect(codes.filter((code) => dictionaryErrorMessage(code).startsWith('Não foi'))).toEqual([]);
    expect(dictionaryErrorMessage('IO')).toBe('Não foi possível concluir (IO).');
    expect(
      importSummary({ name: 'pt_br.txt', words: 1, discarded: 1, encoding: 'UTF-8', pair: false }),
    ).toBe('“pt_br” importado: 1 palavra, 1 descartada (lido como UTF-8).');
  });
});
