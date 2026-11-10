import liveFixture from '@simplemd/core/fixtures/live-preview.md?raw';
import {
  generateLargeMarkdown,
  generateRichMarkdown,
  generateRichR7Markdown,
  generateTasksVault,
  generateVault,
} from '@simplemd/core/testing';
import calcFixture from '@simplemd/plugins-internal/fixtures/calc-fixture.md?raw';
import exportFixture from '@simplemd/plugins-internal/fixtures/export-fixture.md?raw';
import richFixture from '@simplemd/plugins-internal/fixtures/rich.md?raw';
import calcExampleMain from '../../../plugins-examples/calc/main.js?raw';
import calcExampleManifest from '../../../plugins-examples/calc/manifest.json?raw';
import helloMain from '../../../plugins-examples/hello-world/main.js?raw';
import helloManifest from '../../../plugins-examples/hello-world/manifest.json?raw';
import probeMain from './fixtures/plugins/probe/main.js?raw';
import probeManifest from './fixtures/plugins/probe/manifest.json?raw';
import { MEMORY_ROOT, type MemoryFsPort } from '@simplemd/vault/testing';
import { fxR7, fxR7Images, fxR7Oversize } from './fixtures/r7';

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
  | 'FX-FM-257K'
  | 'FX-WORDS'
  | 'FX-NOTES'
  | 'FX-R7'
  | 'FX-RICH-R7-10K'
  | 'FX-2000-TASKS'
  | 'FX-R13'
  | 'FX-SEARCH';

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

/**
 * r13 (handoff design-0 §4.7, arch-ux §3): os nomes da referência do usuário — 10 pastas no topo
 * (`_to_delete` = `b/` do AC-13.4, verde próprio), herdeiras em `Medicina` (`Plantões` rosa
 * próprio corta), pasta oculta fora da sequência e notas em pasta tingida. Sem `appearance`: a
 * seção Explorador das Configurações liga os estilos.
 */
function fxR13(): Files {
  const files: Files = { 'raiz.md': NOTA, '.trash/velha.md': NOTA };
  for (const folder of [
    '_Inbox',
    '_to_delete',
    '2026',
    'Aplicativos',
    'Evcoluções',
    'Gestão escala - projeto',
    'Medicina',
    'pasta sem título',
    'pasta sem título 2',
    'Receitas',
  ])
    files[`${folder}/nota.md`] = NOTA;
  files['Medicina/Cardiologia/Arritmias/ecg.md'] = NOTA;
  files['Medicina/Plantões/escala-outubro.md'] = NOTA;
  files['.simplemd/config.json'] =
    '{"folderColors":{"_to_delete":"green","Medicina/Plantões":"pink"}}\n';
  return files;
}

/**
 * FX-SEARCH (r37c, design-r37 §7): a busca no texto. "acao" acha Ação, AÇÃO, acao e a forma NFD; a
 * posição certa com CRLF e com BOM; nota com 12 casamentos (5 trechos e a contagem); linha longa
 * (trecho cortado nas duas pontas); trecho hostil (`<img onerror>`, `<script>`: só texto na lista) e
 * nome com U+202E (direção isolada). Pulados: 2 MiB + 1, não UTF-8, só na nuvem e dois links (os dois
 * últimos em `PRESET_SETUP`); `.simplemd/` e `.oculta/` nunca entram. 21 resultados em 8 notas.
 */
function fxSearch(): Files {
  const many = Array.from({ length: 12 }, (_, i) => `Linha ${i + 1}: ação.`).join('\n');
  const utf8 = new TextEncoder();
  return {
    'receitas/feijoada.md':
      '# Feijoada\n\nA ação começa cedo.\nAÇÃO também conta, e acao sem acento.\n',
    'notas/crlf.md': '# CRLF\r\n\r\nPrimeira linha.\r\nA ação fica na quarta linha.\r\n',
    'notas/bom.md': '\uFEFF# Com BOM\n\nAÇÃO logo na terceira linha.\n',
    'notas/nfd.md': '# Decomposta\n\nAc\u0327a\u0303o em NFD (c + cedilha, a + til).\n',
    'notas/muitas.md': `# Muitas\n\n${many}\n`,
    'notas/longa.md': `# Longa\n\n${'antes '.repeat(20)}ação${' depois'.repeat(30)}\n`,
    'hostil/xss.md':
      '# Hostil\n\nação <img src=x onerror="window.__xss=1"> <script>window.__xss=2</script>\n',
    'hostil/fatura\u202Etxt.md': '# Fatura\n\nação num nome com U+202E.\n',
    // 2 MiB + 1 byte, só ASCII (2.097.150 + 3): pulada sem ler (`tooLarge`), com o termo dentro.
    'grande.md': `${'acao\n'.repeat(419_430)}fim`,
    // "ação" em Latin-1 (E7 E3): não é UTF-8 (`notUtf8`).
    'latin1.md': new Uint8Array([
      ...utf8.encode('# Latin-1\n\nA'),
      0xe7,
      0xe3,
      ...utf8.encode('o em Latin-1.\n'),
    ]),
    'nuvem/so-na-nuvem.md': '# Só na nuvem\n\nA ação desta nota não é lida.\n',
    'sem-termo.md': '# Sem o termo\n\nNada aqui.\n',
    '.simplemd/segredo.md': '# Segredo\n\nação escondida\n',
    '.oculta/nota.md': '# Oculta\n\nação oculta\n',
  };
}

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
  // r2 etapa 8 (arch-ux r2 §11.2): ACP-WORDS e ACP-NOTES.
  'FX-WORDS': () => ({
    'palavras.md': 'O paralelepípedo da rua e outro paralelepípedo na calçada.\n\n',
  }),
  'FX-NOTES': () => ({
    'Receitas/bolo.md': FM_VALID,
    'diario/hoje.md': '# Hoje\n\nVeja \n',
  }),
  // r7 S0 (product r7 §6): vault de I-1…I-10, documento rico de 10.000 linhas (com as imagens do
  // FX-R7) e 2.000 notas × 20 tarefas.
  'FX-R7': () => ({ ...fxR7(), ...fxR7Oversize() }),
  'FX-RICH-R7-10K': () => ({ ...fxR7Images(), 'rich-r7-10k.md': generateRichR7Markdown() }),
  'FX-2000-TASKS': () => generateTasksVault(),
  'FX-R13': fxR13,
  'FX-SEARCH': fxSearch,
};

/**
 * Ajustes da árvore depois do `seed` (r37c), o que `Files` não descreve: links simbólicos e notas
 * só na nuvem (`MemoryFsPort.setCloudOnly`, r36b).
 */
export const PRESET_SETUP: Partial<Record<PresetId, (port: MemoryFsPort) => void>> = {
  'FX-SEARCH': (port) => {
    port.symlink('atalho.md', `${MEMORY_ROOT}/receitas/feijoada.md`);
    port.symlink('atalho-pasta', `${MEMORY_ROOT}/receitas`);
    port.setCloudOnly('nuvem/so-na-nuvem.md');
  },
};

export const isPresetId = (value: string | null): value is PresetId =>
  value !== null && value in PRESETS;
