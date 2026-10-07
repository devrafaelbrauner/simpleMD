import liveFixture from '@simplemd/core/fixtures/live-preview.md?raw';
import { generateLargeMarkdown, generateRichMarkdown } from '@simplemd/core/testing';
import calcFixture from '@simplemd/plugins-internal/fixtures/calc-fixture.md?raw';
import exportFixture from '@simplemd/plugins-internal/fixtures/export-fixture.md?raw';
import richFixture from '@simplemd/plugins-internal/fixtures/rich.md?raw';
import calcExampleMain from '../../../plugins-examples/calc/main.js?raw';
import calcExampleManifest from '../../../plugins-examples/calc/manifest.json?raw';
import helloMain from '../../../plugins-examples/hello-world/main.js?raw';
import helloManifest from '../../../plugins-examples/hello-world/manifest.json?raw';
import probeMain from './fixtures/plugins/probe/main.js?raw';
import probeManifest from './fixtures/plugins/probe/manifest.json?raw';

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
  | 'FX-LATIN1'
  | 'FX-PLUG-HELLO'
  | 'FX-PLUG-PROBE'
  | 'FX-RICH'
  | 'FX-RICH-10K'
  | 'FX-CALC'
  | 'FX-EXPORT'
  | 'FX-MMD-XSS'
  | 'FX-PLUG-CALC';

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

/** Arquivos de um plugin instalado (H11). */
export function pluginFiles(id: string, manifest: string, main: string): Files {
  return {
    [`.simplemd/plugins/${id}/manifest.json`]: manifest,
    [`.simplemd/plugins/${id}/main.js`]: main,
  };
}

/** FX-MMD-XSS (AC-7.4): `click … call alert`, `javascript:` e um rótulo `<img onerror>`. */
const MERMAID_XSS = [
  '# XSS no Mermaid',
  '',
  '```mermaid',
  'flowchart TD',
  '  A["<img src=x onerror=alert(1)>"] --> B[b]',
  '  click A call alert(1)',
  '  click B "javascript:alert(1)"',
  '```',
  '',
  'fim',
  '',
].join('\n');

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
  // r2 etapa 6 (arch-frontend r2 §15, H11): plugins copiados para `.simplemd/plugins/<id>/`.
  'FX-PLUG-HELLO': () => ({
    'nota.md': NOTA,
    ...pluginFiles('com.exemplo.hello-world', helloManifest, helloMain),
  }),
  'FX-PLUG-PROBE': () => ({
    'nota.md': NOTA,
    ...pluginFiles('com.teste.sonda', probeManifest, probeMain),
  }),
  // r2 etapa 7 (arch-ux r2 §11.2): renderização por plugins internos.
  'FX-RICH': () => ({ 'rich.md': richFixture }),
  'FX-RICH-10K': () => ({ 'rich-10k.md': generateRichMarkdown() }),
  'FX-CALC': () => ({ 'calc-fixture.md': calcFixture }),
  'FX-EXPORT': () => ({ 'export-fixture.md': exportFixture }),
  'FX-MMD-XSS': () => ({ 'xss.md': MERMAID_XSS }),
  // AC-7.9: o calc interno desligado e o exemplo externo instalado (falta aprovar no L6).
  'FX-PLUG-CALC': () => ({
    'calc-fixture.md': calcFixture,
    '.simplemd/config.json': '{"plugins":{"internal":{"simplemd.calc":false}}}\n',
    ...pluginFiles('com.exemplo.calc', calcExampleManifest, calcExampleMain),
  }),
  'FX-LATIN1': () => ({
    'nota.md': NOTA,
    'latin1.md': new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x0a]),
  }),
};

export const isPresetId = (value: string | null): value is PresetId =>
  value !== null && value in PRESETS;
