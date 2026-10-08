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
  // Pizza (A11Y-R2-01, F-R2-07): separadores entre fatias com a cor do fundo (um vão, ≥ 3:1 contra
  // toda fatia), contorno externo `muted` (P26), percentuais na cor do fundo sobre a fatia, legenda
  // e título em `fg` (P1).
  pieStrokeColor: '--color-bg',
  pieOuterStrokeColor: '--color-muted',
  pieSectionTextColor: '--color-bg',
  pieLegendTextColor: '--color-fg',
  pieTitleTextColor: '--color-fg',
  fontFamily: '--fontFamily-ui',
  fontSize: '--dimension-ui-font-size',
};

/**
 * Cores das fatias `pie1…pie12` (A11Y-R2-01/F-R2-07; acréscimo ao DESIGN §8.18, que não mapeava a
 * pizza: sem token novo). Só tokens com ≥ 4,5:1 sobre `bg` nos dois temas embutidos (`accent`,
 * `fg`, `muted`) e misturas `color-mix(in srgb, A p, B)` deles com `fg`, `muted` e `border`. Cada
 * entrada é `[A, B, p]`; sem `B`, o próprio token. A mistura usa os valores LIDOS no render.
 *
 * Ordem (G-02/A11Y-R2-06, D-C1): o Mermaid pinta a fatia i com `pie_i`, na ordem da fonte, e a
 * última encosta na primeira. A ordem 2,5,4,3,8,6,1,7,10,11,12,9 das receitas anteriores mantém o
 * fim da P-3 da marca e iguala ou supera a P-3 na ΔE00 de qualquer par para n ≤ 6; o par (1,2) fica
 * ≥ 3:1 nos dois temas (a pizza de 2 fatias); os mínimos entre vizinhas não caem abaixo dos de
 * `765b9c1` (1,14 nos dois temas; o claro sobe para 1,23). Resíduo aceito: vizinhas < 3:1 no
 * escuro (≥ 3:1 em todo par é inviável com cada fatia ≥ 4,5:1 sobre `bg`); a exportação descreve
 * os dados em `<desc>`.
 */
export const PIE_SLICE_MIXES: readonly (readonly [string, string?, number?])[] = [
  ['--color-fg'],
  ['--color-accent', '--color-border', 0.5],
  ['--color-accent', '--color-fg', 0.5],
  ['--color-muted'],
  ['--color-fg', '--color-muted', 0.5],
  ['--color-accent', '--color-fg', 0.75],
  ['--color-accent'],
  ['--color-accent', '--color-fg', 0.25],
  ['--color-accent', '--color-muted', 0.25],
  ['--color-fg', '--color-muted', 0.75],
  ['--color-accent', '--color-muted', 0.5],
  ['--color-accent', '--color-border', 0.75],
];

/** Fatias opacas: a opacidade 0,7 padrão do Mermaid misturaria a fatia com o fundo. */
const PIE_OPACITY = '1';

/** `#rgb`, `#rgba`, `#rrggbb` ou `#rrggbbaa` (o formato dos temas) → canais RGB; alfa ignorado. */
function hexChannels(value: string): [number, number, number] | null {
  const match = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(value);
  if (!match) return null;
  const digits = match[1]!;
  const full = digits.length <= 4 ? [...digits.slice(0, 3)].map((c) => c + c).join('') : digits;
  return [0, 2, 4].map((i) => Number.parseInt(full.slice(i, i + 2), 16)) as [
    number,
    number,
    number,
  ];
}

/** `color-mix(in srgb, a p, b)` em hexadecimal (o Mermaid só entende cores hexadecimais). */
export function mixHex(a: string, b: string, weight: number): string | null {
  const x = hexChannels(a);
  const y = hexChannels(b);
  if (!x || !y) return null;
  return `#${x
    .map((channel, i) => Math.round(channel * weight + y[i]! * (1 - weight)))
    .map((channel) => channel.toString(16).padStart(2, '0'))
    .join('')}`;
}

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
  PIE_SLICE_MIXES.forEach(([a, b, weight = 1], i) => {
    const first = read(a).trim();
    const value = b === undefined ? first : mixHex(first, read(b).trim(), weight);
    if (value) vars[`pie${i + 1}`] = value;
  });
  vars.pieOpacity = PIE_OPACITY;
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

/**
 * Fatias de uma pizza como o parser do Mermaid as leu (rótulo → valor), na mesma fila. Falha da
 * análise → `null`: a exportação segue com o SVG, só sem `<title>`/`<desc>` (CR3-C2).
 */
function pieSections(source: string): Promise<ReadonlyMap<string, number> | null> {
  const job = queue.then(async () => {
    try {
      const { db } = await (await loadMermaid()).mermaidAPI.getDiagramFromText(source);
      const { getSections } = db as { getSections?: unknown };
      return typeof getSections === 'function'
        ? (getSections.call(db) as ReadonlyMap<string, number>)
        : null;
    } catch {
      return null;
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

/**
 * SVG final de um diagrama para a exportação (R-10.4; arch-frontend r2 §10.2): mesma renderização e
 * versão do editor, com o mesmo pós-processamento {@link finishSvg} (nome acessível, sem script,
 * `on*` ou `javascript:`). Fonte inválida → `null` (a exportação mostra o código cru).
 *
 * A11Y-R2-06 (só na exportação; no editor a fonte Markdown é a alternativa): uma pizza ganha
 * `<title>` (o mesmo nome do `aria-label`) e `<desc>` com "rótulo: valor; …" na ordem da fonte, lidos
 * pelo parser do Mermaid (aspas, `showData` e rótulos repetidos como ele desenhou). Um `accDescr` do
 * autor fica, com os dados depois de " — ".
 */
export async function renderMermaidMarkup(
  source: string,
  vars: Readonly<Record<string, string>>,
): Promise<string | null> {
  const render = await renderMermaid(source, vars);
  if (!render.ok) return null;
  const template = document.createElement('template');
  template.innerHTML = render.svg;
  const svg = template.content.querySelector('svg');
  if (!svg) return null;
  finishSvg(svg, mermaidLabel(source));
  const sections =
    svg.getAttribute('aria-roledescription') === 'pie' ? await pieSections(source) : null;
  if (sections) {
    const data = [...sections].map(([label, value]) => `${label}: ${value}`).join('; ');
    let title = svg.querySelector(':scope > title');
    if (!title) {
      title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
      title.textContent = mermaidLabel(source);
      svg.prepend(title);
    }
    const desc = svg.querySelector(':scope > desc');
    if (desc) desc.textContent = `${desc.textContent} — ${data}`;
    else {
      const created = document.createElementNS('http://www.w3.org/2000/svg', 'desc');
      created.textContent = data;
      title.after(created);
    }
  }
  return svg.outerHTML;
}
