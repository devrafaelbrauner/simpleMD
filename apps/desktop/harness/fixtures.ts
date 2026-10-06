import liveFixture from '@simplemd/core/fixtures/live-preview.md?raw';
import { generateLargeMarkdown } from '@simplemd/core/testing';

/** Vaults pré-montados do harness (arch-ux §9.1; `?vault=<id>`). */
export type PresetId =
  | 'FX-SMALL'
  | 'FX-EMPTY'
  | 'FX-2000'
  | 'FX-LP'
  | 'FX-DUP'
  | 'FX-LONG'
  | 'FX-10K'
  | 'FX-1MB'
  | 'FX-CFG-BAD'
  | 'FX-CFG-UNK'
  | 'FX-LATIN1';

type Files = Record<string, string | Uint8Array>;

const NOTA = '# Nota\n\nTexto da nota.\n';
const HIDDEN_AND_CONFIG: Files = {
  'b.txt': 'não é markdown',
  '.hidden.md': '# oculto\n',
  '.simplemd/config.json': '{}\n',
};

function explorer2000(): Files {
  const files: Files = {};
  for (let d = 1; d <= 20; d++) {
    const folder = `pasta-${String(d).padStart(2, '0')}`;
    for (let n = 1; n <= 100; n++) {
      const name = `nota-${String(n).padStart(3, '0')}`;
      files[`${folder}/${name}.md`] = `# ${folder}/${name}\n\nConteúdo de ${name}.\n`;
    }
  }
  return files;
}

/** Arquivo de ~1 MB (NFR-6): linhas geradas até passar de 1.048.576 bytes. */
function oneMegabyte(): string {
  const text = generateLargeMarkdown(30_000, 2);
  return text.slice(0, text.indexOf('\n', 1_048_576) + 1);
}

const LONG_NAME = `${'nome-muito-longo-'.repeat(7)}x`.slice(0, 117) + '.md';

export const PRESETS: Record<PresetId, () => Files> = {
  'FX-SMALL': () => ({
    'nota.md': NOTA,
    'a.md': '# A\n',
    'sub/c.md': '# C\n',
    ...HIDDEN_AND_CONFIG,
  }),
  'FX-EMPTY': () => ({ ...HIDDEN_AND_CONFIG }),
  'FX-2000': explorer2000,
  'FX-LP': () => ({ 'live-preview.md': liveFixture }),
  'FX-DUP': () => ({ 'a/nota.md': '# a/nota\n', 'b/nota.md': '# b/nota\n' }),
  'FX-LONG': () => ({ [`nivel-1/nivel-2/nivel-3/${LONG_NAME}`]: '# Nome longo\n' }),
  'FX-10K': () => ({ 'grande.md': generateLargeMarkdown(10_000, 1) }),
  'FX-1MB': () => ({ 'um-mega.md': oneMegabyte() }),
  'FX-CFG-BAD': () => ({ 'nota.md': NOTA, '.simplemd/config.json': '{ "theme": ' }),
  'FX-CFG-UNK': () => ({ 'nota.md': NOTA, '.simplemd/config.json': '{"x":1}' }),
  'FX-LATIN1': () => ({
    'nota.md': NOTA,
    'latin1.md': new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x0a]),
  }),
};

export const isPresetId = (value: string | null): value is PresetId =>
  value !== null && value in PRESETS;
