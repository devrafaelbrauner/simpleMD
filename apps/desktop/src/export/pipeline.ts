import {
  exportDocument,
  extractNoteMeta,
  frontMatterLang,
  renderExportBody,
  stripFrontMatter,
} from '@simplemd/core';
import exportCss from '@simplemd/core/export.css?raw';
import { lightTokens } from '@simplemd/themes';
import { encodeDocument, type TextFormat } from '@simplemd/vault';
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
 */
export async function exportHtml(
  doc: string,
  path: string,
  enabled: PluginEnabled,
): Promise<string> {
  const renderers = await createExportRenderers(doc, { enabled, tokens: lightTokens });
  const { bodyHtml, usesMath } = await renderExportBody(doc, { renderers, mode: 'file' });
  // Import dinâmico de propósito: ~300 KB de fontes `data:` só quando a nota tem fórmula (AC-10.5).
  const katex = usesMath ? (await import('./katex-inline-css')).katexInlineCss() : '';
  return exportDocument({
    title: extractNoteMeta(doc, path).title,
    lang: frontMatterLang(doc) ?? 'pt-BR',
    css: [lightRootCss(), katex, exportCss].filter((part) => part !== '').join('\n'),
    bodyHtml,
  });
}

/** Corpo da visualização de impressão (imagens viram o texto alternativo; R-10.5). */
export async function printBody(doc: string, enabled: PluginEnabled): Promise<string> {
  const renderers = await createExportRenderers(doc, { enabled, tokens: lightTokens });
  return (await renderExportBody(doc, { renderers, mode: 'print' })).bodyHtml;
}
