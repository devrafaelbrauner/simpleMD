import {
  extractNoteMeta,
  type ExportBody,
  type ExportImages,
  type ExportWikilinks,
} from '@simplemd/core';
import {
  exportDocument,
  frontMatterLang,
  renderExportBody,
  stripFrontMatter,
} from '@simplemd/core/export';
import exportCss from '@simplemd/core/export.css?raw';
import { lightTokens } from '@simplemd/themes';
import { encodeDocument, type TextFormat } from '@simplemd/vault';
import { exportSanitizer } from './normalize';
import { createExportRenderers } from './renderers';

/**
 * Pipeline da exportação (etapa 10; arch-frontend r2 §10.2–§10.3). Carregado sob demanda na primeira
 * exportação (§14.2): serializador, renderizadores e o CSS do KaTeX com fontes embutidas ficam fora
 * do bundle principal. Tudo parte do BUFFER ATUAL da aba (texto do editor: só `\n`, sem BOM).
 */
export type PluginEnabled = (id: string) => boolean;

const encoder = new TextEncoder();

/**
 * `.md` limpo (R-10.2, AC-10.1): os mesmos bytes que salvar gravaria (`encodeDocument` + UTF-8,
 * com o fim de linha e o BOM originais); "Sem front matter" tira só o bloco e uma linha em branco.
 */
export function markdownBytes(doc: string, format: TextFormat, stripFm: boolean): Uint8Array {
  return encoder.encode(encodeDocument(stripFm ? stripFrontMatter(doc) : doc, format));
}

/** `:root{…}` com os valores claros lidos de tokens.css em tempo de execução (D-19, FDV-8). */
function lightRootCss(): string {
  const declarations = Object.entries(lightTokens).map(([name, value]) => `${name}:${value}`);
  return `:root{${declarations.join(';')}}`;
}

/**
 * HTML autocontido (R-10.4): título pela regra R-9.3, `lang` do front matter (senão pt-BR), uma
 * folha embutida (tokens claros + KaTeX com fontes `data:` só quando há fórmula + export.css).
 * Imagens do vault só pelo mapa (`embedImages`, `data:`); sem mapa, saem como texto alternativo.
 */
export async function exportHtml(
  doc: string,
  path: string,
  enabled: PluginEnabled,
  images: ExportImages = { notePath: path, map: new Map() },
  wikilinks?: ExportWikilinks,
): Promise<string> {
  const renderers = await createExportRenderers(doc, {
    enabled,
    tokens: lightTokens,
    notePath: path,
  });
  const { bodyHtml, usesMath } = await renderExportBody(doc, {
    renderers,
    mode: 'file',
    images,
    sanitizer: await exportSanitizer(),
    ...(wikilinks ? { wikilinks } : {}),
  });
  // Import dinâmico de propósito: ~300 KB de fontes `data:` só quando a nota tem fórmula (AC-10.5).
  const katex = usesMath ? (await import('./katex-inline-css')).katexInlineCss() : '';
  return exportDocument({
    title: extractNoteMeta(doc, path).title,
    lang: frontMatterLang(doc) ?? 'pt-BR',
    css: [lightRootCss(), katex, exportCss].filter((part) => part !== '').join('\n'),
    bodyHtml,
  });
}

/**
 * Corpo da visualização de impressão: imagens do vault pelo mapa (`printImages`, `blob:` da cache
 * da janela; AC-EX.2); remotas viram o texto alternativo (R-10.5).
 */
export async function printBody(
  doc: string,
  enabled: PluginEnabled,
  images: ExportImages,
  wikilinks?: ExportWikilinks,
): Promise<string> {
  const renderers = await createExportRenderers(doc, {
    enabled,
    tokens: lightTokens,
    notePath: images.notePath ?? '',
  });
  return (
    await renderExportBody(doc, {
      renderers,
      mode: 'print',
      images,
      sanitizer: await exportSanitizer(),
      ...(wikilinks ? { wikilinks } : {}),
    })
  ).bodyHtml;
}

/** Blocos de topo da prévia: HTML de cada um e a linha da nota em que começa (âncoras, r38). */
export type PreviewBlocks = NonNullable<ExportBody['blocks']>;

/**
 * Corpo da prévia lado a lado (r38, D-R38-02): o mesmo serializador e a mesma política do HTML cru
 * da impressão (`mode: 'print'`: remotas viram o texto alternativo, como a CSP do app exige; as do
 * vault chegam como `blob:` da cache da janela), com as cores do tema ATUAL no Mermaid (`tokens`)
 * e os blocos de topo separados, cada um com a sua linha.
 */
export async function previewBody(
  doc: string,
  enabled: PluginEnabled,
  images: ExportImages,
  tokens: Readonly<Record<string, string>>,
  wikilinks?: ExportWikilinks,
): Promise<PreviewBlocks> {
  const renderers = await createExportRenderers(doc, {
    enabled,
    tokens,
    notePath: images.notePath ?? '',
  });
  const { blocks } = await renderExportBody(doc, {
    renderers,
    mode: 'print',
    images,
    sanitizer: await exportSanitizer(),
    blocks: true,
    ...(wikilinks ? { wikilinks } : {}),
  });
  return blocks ?? [];
}
