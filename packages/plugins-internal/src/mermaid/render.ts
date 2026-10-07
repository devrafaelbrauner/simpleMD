import type mermaidLibrary from 'mermaid';

type Mermaid = typeof mermaidLibrary;

/** Contagem de renderizações (espião do NFR-21/NFR-22: 0 por edições fora do diagrama). */
export const mermaidRenderCounts = { mermaid: 0 };

export type MermaidRender =
  | {
      readonly ok: true;
      /** SVG da biblioteca (`securityLevel: 'strict'`, sanitizado pelo DOMPurify dela). */
      readonly svg: string;
      /** Id usado no `render`; cada widget troca por um id próprio (sem ids duplicados no DOM). */
      readonly id: string;
    }
  | { readonly ok: false; readonly message: string };

/**
 * Cores do diagrama (DESIGN §8.18, Q-R2-3): cada variável do tema `base` do Mermaid lê o valor
 * CALCULADO de um token no momento da renderização. Nenhum valor é transcrito aqui.
 */
export const THEME_VARIABLE_TOKENS: Readonly<Record<string, string>> = {
  background: '--color-bg',
  edgeLabelBackground: '--color-bg',
  tertiaryColor: '--color-bg',
  primaryColor: '--color-code-bg',
  mainBkg: '--color-code-bg',
  secondaryColor: '--color-code-bg',
  clusterBkg: '--color-code-bg',
  primaryTextColor: '--color-fg',
  textColor: '--color-fg',
  titleColor: '--color-fg',
  nodeTextColor: '--color-fg',
  primaryBorderColor: '--color-muted',
  secondaryBorderColor: '--color-muted',
  tertiaryBorderColor: '--color-muted',
  nodeBorder: '--color-muted',
  clusterBorder: '--color-muted',
  lineColor: '--color-muted',
  fontFamily: '--fontFamily-ui',
  fontSize: '--dimension-ui-font-size',
};

/**
 * `themeVariables` a partir de um leitor de propriedades (DOM no app, tokens claros na exportação).
 * Um token sem valor fica de fora (o Mermaid usa o padrão do tema `base`).
 */
export function themeVariables(read: (property: string) => string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const [name, token] of Object.entries(THEME_VARIABLE_TOKENS)) {
    const value = read(token).trim();
    if (value !== '') vars[name] = value;
  }
  return vars;
}

/** Já houve pedido da biblioteca? (AC-7.12: documento sem Mermaid → nunca.) */
export function mermaidRequested(): boolean {
  return loading !== null;
}

let loading: Promise<Mermaid> | null = null;

/** Carrega o Mermaid só quando um bloco fica visível (R-7.2, AC-7.12). */
export function loadMermaid(): Promise<Mermaid> {
  loading ??= import('mermaid').then((module) => module.default);
  return loading;
}

/** FNV-1a de 32 bits em hexadecimal: ids de SVG curtos e estáveis. */
export function hashText(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

let sequence = 0;
let queue: Promise<unknown> = Promise.resolve();

/**
 * Renderiza um diagrama. As chamadas entram numa fila: `initialize` do Mermaid é global, então duas
 * renderizações nunca se intercalam. Fonte inválida → `{ ok: false, message }`, nunca exceção.
 */
export function renderMermaid(
  source: string,
  vars: Readonly<Record<string, string>>,
): Promise<MermaidRender> {
  const job = queue.then(async (): Promise<MermaidRender> => {
    const mermaid = await loadMermaid();
    mermaidRenderCounts.mermaid++;
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      suppressErrorRendering: true,
      htmlLabels: false,
      flowchart: { htmlLabels: false },
      theme: 'base',
      themeVariables: { ...vars },
    });
    const id = `mmd-${hashText(source)}-${++sequence}`;
    try {
      const { svg } = await mermaid.render(id, source);
      return { ok: true, svg, id };
    } catch (error) {
      // Sobras do contêiner temporário do Mermaid, se ele não limpou.
      document.getElementById(`d${id}`)?.remove();
      return { ok: false, message: errorMessage(error) };
    }
  });
  queue = job.catch(() => undefined);
  return job;
}

function errorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const text = raw.replace(/\s+/g, ' ').trim();
  return text.length > 300 ? `${text.slice(0, 299)}…` : text || 'erro de sintaxe';
}

/** STR-84: "Diagrama Mermaid: <primeira linha>". */
export function mermaidLabel(source: string): string {
  const first = source.split('\n').find((line) => line.trim() !== '') ?? '';
  return `Diagrama Mermaid: ${first.trim()}`;
}

/**
 * Pós-processamento do SVG já no DOM (R-7.2, AC-7.4, axe): `role="img"` + nome; sem
 * `aria-labelledby`/`aria-describedby` nem ids de `title`/`desc` (ids duplicados entre diagramas);
 * e, por defesa em profundidade, nenhum `<script>`, atributo `on*` ou URL `javascript:`.
 */
export function finishSvg(svg: SVGSVGElement, label: string): void {
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', label);
  svg.removeAttribute('aria-labelledby');
  svg.removeAttribute('aria-describedby');
  for (const el of svg.querySelectorAll('title, desc')) el.removeAttribute('id');
  for (const el of svg.querySelectorAll('script')) el.remove();
  for (const el of [svg, ...svg.querySelectorAll('*')]) {
    for (const attr of [...el.attributes]) {
      // Navegadores ignoram espaços e controles dentro do esquema (`java\tscript:`).
      const value = [...attr.value]
        .filter((char) => char.charCodeAt(0) > 32)
        .join('')
        .toLowerCase();
      if (attr.name.toLowerCase().startsWith('on') || value.startsWith('javascript:'))
        el.removeAttribute(attr.name);
    }
  }
}
