import { escapeHtml, type ExportRenderers, type ExportSegment } from '@simplemd/core';
import { calcTokenSpans, renderCalc } from '@simplemd/plugins-internal/calc/render';
import {
  displayMathAt,
  inlineMathInText,
  loadKatex,
  renderMath,
} from '@simplemd/plugins-internal/katex/render';
import { renderMermaidMarkup, themeVariables } from '@simplemd/plugins-internal/mermaid/render';
import { normalizeRenderers } from './normalize';

/** Ids dos plugins internos (os mesmos descritores de `plugins/internal/<id>.ts`). */
export const INTERNAL_IDS = {
  mermaid: 'simplemd.mermaid',
  katex: 'simplemd.katex',
  calc: 'simplemd.calc',
  tasks: 'simplemd.tasks',
} as const;

export interface RendererOptions {
  /** O plugin interno está ligado? Desligado → o conteúdo dele sai cru (R-10.4). */
  enabled(id: string): boolean;
  /** Valores claros dos tokens (D-19): as cores do Mermaid na exportação. */
  readonly tokens: Readonly<Record<string, string>>;
  /** Nota exportada (r7: `FROM [[nota]]` das consultas resolve a partir dela). */
  readonly notePath: string;
}

/**
 * Renderizadores da exportação (arch-frontend r2 §10.2): as MESMAS funções puras e a mesma versão
 * das bibliotecas dos plugins internos (entradas `./<nome>/render`), só para os plugins ligados.
 * O KaTeX é carregado antes (as chamadas em linha são síncronas) e só se o texto tem `$`. Toda
 * saída passa pelo parser do navegador e sai re-serializada e conferida (APPSEC-R2-12).
 */
export async function createExportRenderers(
  doc: string,
  opts: RendererOptions,
): Promise<ExportRenderers> {
  const renderers: ExportRenderers = {};
  const calcOn = opts.enabled(INTERNAL_IDS.calc);
  const katex = opts.enabled(INTERNAL_IDS.katex) && doc.includes('$') ? await loadKatex() : null;
  if (katex || calcOn) {
    renderers.inline = (text, blocked) => {
      const out: ExportSegment[] = [];
      // As regras do editor (R-7.3/R-7.4): matemática fora do código; calc fora do código e da
      // matemática (mesmo de uma fórmula inválida, que fica crua).
      const math = katex ? inlineMathInText(text, blocked) : [];
      if (katex) {
        for (const span of math) {
          const render = renderMath(katex, span.tex, false);
          if (render.error === null)
            out.push({ from: span.from, to: span.to, html: render.html, math: true });
        }
      }
      if (calcOn) {
        const skip = [...blocked, ...math];
        for (const token of calcTokenSpans(text)) {
          if (skip.some((span) => span.from <= token.to - 1 && span.to >= token.from)) continue;
          const result = renderCalc(text.slice(token.from, token.to));
          if (result)
            out.push({
              ...token,
              html: `<span class="smd-calc">${escapeHtml(result.text)}</span>`,
              math: false,
            });
        }
      }
      return out.sort((a, b) => a.from - b.from);
    };
  }
  if (katex) {
    renderers.block = async (text) => {
      const found = displayMathAt(text);
      if (!found) return null;
      const render = renderMath(katex, found.tex, true);
      return render.error === null ? { html: render.html, end: found.end } : null;
    };
  }
  const mermaidOn = opts.enabled(INTERNAL_IDS.mermaid);
  const vars = mermaidOn ? themeVariables((token) => opts.tokens[token] ?? '') : null;
  // r7 AC-EX.4: consultas como instantâneo dos resultados na hora da exportação; plugin desligado
  // (ou ainda não carregado) → cerca crua (R-I9.9).
  // Import dinâmico: o registro do `simplemd.tasks` também o carrega assim, e o módulo fica num
  // pedaço próprio minúsculo (sem arrastar a exportação para a carga do plugin).
  const queries = opts.enabled(INTERNAL_IDS.tasks)
    ? (await import('./query-source')).querySnapshotRenderer()
    : null;
  if (vars || queries) {
    renderers.fence = async (info, code) => {
      const query = queries?.(info, code, opts.notePath) ?? null;
      if (query !== null) return { html: query };
      if (!vars || info.split(/\s/)[0] !== 'mermaid') return null;
      const svg = await renderMermaidMarkup(code, vars);
      return svg === null ? null : { html: `<figure class="smd-mermaid">${svg}</figure>` };
    };
  }
  return normalizeRenderers(renderers);
}
