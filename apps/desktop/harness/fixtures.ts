import liveFixture from '@simplemd/core/fixtures/live-preview.md?raw';
import { generateLargeMarkdown, generateRichMarkdown, generateVault } from '@simplemd/core/testing';
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
  | 'FX-PLUG-CALC'
  | 'FX-CAT-2000'
  | 'FX-TOC'
  | 'FX-FM-VALID'
  | 'FX-FM-INVALID'
  | 'FX-FM-WARN'
  | 'FX-FM-257K';

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

/** FX-TOC (AC-9.5): h1, h2, h3, setext h2, `# fake` em código e `title:` no front matter. */
const TOC_DOC = [
  '---',
  'title: Título do YAML',
  '---',
  '# Um',
  '',
  'Texto.',
  '',
  '## Dois',
  '',
  '### Três',
  '',
  '```',
  '# fake',
  '```',
  '',
  'Setext dois',
  '-----------',
  '',
].join('\n');

/** FX-FM-* (AC-9.4, PRP-*): os casos de R-9.2. */
const FM_VALID =
  '---\ntitle: Bolo de fubá\ntags: [receita, doce]\ndate: 2026-10-07\nautor: Ana\n---\n# Bolo\n\nModo de preparo.\n';
const FM_INVALID = '---\ntitle: Quebrado\ntags: a: b\n---\n# Inválido\n';
const FM_WARN = '---\ntitle: 5\ntags: 3\ndate: 07/10/2026\n---\n# Avisos\n';
const FM_257K = `---\ntitle: Grande\nx: "${'a'.repeat(257 * 1024)}"\n---\n# Grande\n`;

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
  // r2 etapa 9 (arch-ux r2 §11.2, H18): vault R-9.9 sem índice (`__simplemdHarness.reopenVault()`
  // depois da gravação do `index.json` = índice quente) e os casos do painel de propriedades.
  // Ritmo da indexação (CAT-INDEXING): `fault('read', { delayMs })`.
  'FX-CAT-2000': () => generateVault(),
  'FX-TOC': () => ({ 'sumario.md': TOC_DOC }),
  'FX-FM-VALID': () => ({ 'receitas/bolo.md': FM_VALID }),
  'FX-FM-INVALID': () => ({ 'invalido.md': FM_INVALID }),
  'FX-FM-WARN': () => ({ 'avisos.md': FM_WARN }),
  'FX-FM-257K': () => ({ 'grande.md': FM_257K }),
};

export const isPresetId = (value: string | null): value is PresetId =>
  value !== null && value in PRESETS;
