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
 * Chaves que nem um `%%{init}%%` nem o front matter do diagrama mudam (F1, r38a2). As seis primeiras
 * são o `secure` padrão do Mermaid, repetidas para não depender de ele juntar a lista dada com a
 * dele. As outras levariam CSS ou HTML da nota ao DOM do app: `themeCSS`, `fontFamily` e
 * `altFontFamily` entram crus no `<style>` (o Mermaid só confere chaves balanceadas, e copia
 * `fontFamily` para `themeVariables` sem a lista de caracteres permitidos delas) e `htmlLabels`
 * poria rótulos HTML em `<foreignObject>`. O Mermaid apaga a chave em qualquer nível da diretiva.
 */
const SECURE_KEYS: readonly string[] = [
  'secure',
  'securityLevel',
  'startOnLoad',
  'maxTextSize',
  'suppressErrorRendering',
  'maxEdges',
  'themeCSS',
  'fontFamily',
  'altFontFamily',
  'htmlLabels',
];

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
      secure: [...SECURE_KEYS],
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

/** Id de um diagrama: `mmd-<hash>-<n>` ({@link renderMermaid}), mais o sufixo de cada widget. */
const DIAGRAM_ID = /^mmd-[\w-]+$/;
/** Animações que toda folha do Mermaid declara (o nome de um `@keyframes` vale no documento todo). */
const MERMAID_KEYFRAMES: Readonly<Record<string, true>> = {
  dash: true,
  'edge-animation-frame': true,
};
const KEYFRAMES_RULE = /^@keyframes[\t\n\f\r ]+([\w-]+)[\t\n\f\r ]*\{/;
const KEYFRAME_SELECTOR = /^[\t\n\f\r ]*(?:from|to|\d+(?:\.\d+)?%)[\t\n\f\r ]*$/;
/**
 * O que a leitura de {@link cssInScope} não imita do CSS (e o stylis do Mermaid nunca escreve):
 * escape, comentário e `<!--`/`-->`; com `image-set(` e `src(`, nenhuma busca.
 */
const UNREAD_CSS = /\\|\/\*|<!--|-->|image-set\(|src\(/i;

/**
 * A folha só alcança o diagrama `#id` (F1, r38a2)? Cada seletor começa em `#id`, sozinho ou seguido
 * de descendente ou filho; a única at-rule aceita é `@keyframes` com nome do próprio Mermaid. Lê a
 * forma compacta do stylis do Mermaid e recusa o resto: string com quebra de linha, parêntese ou
 * colchete sem par, `{`, `}`, `;` ou `@` fora do lugar (regra aninhada, `@font-face`, `@import`,
 * `@layer`, `@media`, `@property`…) e {@link UNREAD_CSS}. `id` já passou por {@link DIAGRAM_ID}.
 */
function cssInScope(css: string, id: string): boolean {
  if (UNREAD_CSS.test(css)) return false;
  // `url(` só sem aspas e para um id do próprio diagrama (o gradiente do Mermaid sem as cores do
  // tema): o token de URL do CSS termina no mesmo `)` que a leitura abaixo, e nada é buscado.
  const urls = css.match(/url\(/gi)?.length ?? 0;
  if (urls !== (css.match(new RegExp(`url\\(#${id}[\\w-]*\\)`, 'g'))?.length ?? 0)) return false;
  let at = 0;
  // Até `stop` fora de string, parênteses e colchetes: os trechos entre vírgulas desse nível
  // (seletores); o cursor fica depois de `stop`. `;` só separa declarações (`stop` = `}`).
  const read = (stop: '{' | '}'): string[] | null => {
    const parts: string[] = [];
    const open: string[] = [];
    let start = at;
    while (at < css.length) {
      const char = css.charAt(at++);
      if (char === '"' || char === "'") {
        const end = css.indexOf(char, at);
        if (end < 0 || /[\n\f\r]/.test(css.slice(at, end))) return null;
        at = end + 1;
      } else if (char === '(' || char === '[') open.push(char === '(' ? ')' : ']');
      else if (char === ')' || char === ']') {
        if (open.pop() !== char) return null;
      } else if (open.length > 0) {
        if ('{};@'.includes(char)) return null;
      } else if (char === ',' || char === stop) {
        parts.push(css.slice(start, at - 1));
        if (char === stop) return parts;
        start = at;
      } else if ('{}@'.includes(char) || (char === ';' && stop === '{')) return null;
    }
    return null;
  };
  const skipSpace = () => {
    while (/[\t\n\f\r ]/.test(css.charAt(at))) at++;
  };
  // `#id` sozinho, ou seguido de descendente (espaço) ou filho (`>`); nunca de `~`, `+` ou `||`
  // (irmãos e colunas fora do SVG), nem de outra letra (outro id) ou de `.`/`:`/`[`.
  const scoped = (selector: string) => {
    const text = selector.replace(/^[\t\n\f\r ]+/, '');
    return (
      text.startsWith(`#${id}`) &&
      /^(?:[\t\n\f\r ]*$|[\t\n\f\r ]*>|[\t\n\f\r ]+(?![\t\n\f\r ~+|]))/.test(
        text.slice(id.length + 1),
      )
    );
  };
  for (skipSpace(); at < css.length; skipSpace()) {
    const keyframes = css.startsWith('@', at) ? KEYFRAMES_RULE.exec(css.slice(at)) : null;
    if (keyframes) {
      if (MERMAID_KEYFRAMES[keyframes[1] ?? ''] !== true) return false;
      at += keyframes[0].length;
      for (skipSpace(); css.charAt(at) !== '}'; skipSpace()) {
        if (!read('{')?.every((frame) => KEYFRAME_SELECTOR.test(frame)) || !read('}')) return false;
      }
      at++;
    } else if (!read('{')?.every(scoped) || !read('}')) return false;
  }
  return true;
}

/**
 * `<style>` que só alcança o próprio diagrama (F1, r38a2): dentro de um `<svg>` com id de diagrama
 * (`mmd-…`, que o app não usa), só com texto e com cada regra no `#id` dele ({@link cssInScope}).
 * O widget do editor e a exportação tiram a folha que falha ({@link finishSvg}); o pós-checagem DOM
 * da exportação e da prévia (`normalizeRender`) recusa a saída.
 */
export function scopedStyle(style: Element): boolean {
  const id = style.closest('svg')?.id ?? '';
  return (
    DIAGRAM_ID.test(id) && style.children.length === 0 && cssInScope(style.textContent ?? '', id)
  );
}

/**
 * Pós-processamento do SVG já no DOM (R-7.2, AC-7.4, axe): `role="img"` + nome; sem
 * `aria-labelledby`/`aria-describedby` nem ids de `title`/`desc` (ids duplicados entre diagramas);
 * e, por defesa em profundidade, nenhum `<script>`, atributo `on*`, URL `javascript:` ou `<style>`
 * que alcance algo fora do diagrama ({@link scopedStyle}).
 */
export function finishSvg(svg: SVGSVGElement, label: string): void {
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', label);
  svg.removeAttribute('aria-labelledby');
  svg.removeAttribute('aria-describedby');
  for (const el of svg.querySelectorAll('title, desc')) el.removeAttribute('id');
  for (const el of svg.querySelectorAll('script')) el.remove();
  for (const el of svg.querySelectorAll('style')) if (!scopedStyle(el)) el.remove();
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
