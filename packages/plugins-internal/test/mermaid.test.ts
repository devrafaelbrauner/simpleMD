import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mermaidExtension, mermaidField, MERMAID_DEBOUNCE_MS } from '../src/mermaid/decorate';
import {
  finishSvg,
  loadMermaid,
  mermaidRenderCounts,
  renderMermaid,
  renderMermaidMarkup,
  scopedStyle,
  themeVariables,
} from '../src/mermaid/render';
import { destroyViews, flatten, mountView, tick } from './helpers';

const FLOW = '```mermaid\nflowchart TD\n  A[Início] --> B{Decisão}\n  B -->|sim| C[Fim]\n```';
const DOC = `# Nota\n\nantes\n\n${FLOW}\n\ndepois\n`;

/** Espera o widget aparecer (render assíncrono fora das transações). */
async function rendered(view: { contentDOM: HTMLElement }, selector = '.cm-mermaid svg') {
  await expect
    .poll(() => view.contentDOM.querySelector(selector), { timeout: 15_000 })
    .not.toBeNull();
  return view.contentDOM.querySelector(selector)!;
}

beforeAll(async () => {
  await loadMermaid();
}, 20_000);
afterEach(destroyViews);

// TA-R2-16: esperas do render assíncrono com limites explícitos (CPU disputada no CI).
describe('Mermaid (AC-7.3, AC-7.4)', { timeout: 30_000 }, () => {
  it('cursor fora → SVG role=img com nome e rótulos dos nós; antes do render, fonte crua', async () => {
    // Fonte que nenhum outro teste renderiza: o cache de renders (por fonte, de propósito) é
    // estado do módulo, e um teste anterior com `DOC` já deixaria o widget pronto (TA-R2-1).
    const flow = FLOW.replace('\n```', '\n  %% só este teste\n```');
    const doc = DOC.replace(FLOW, flow);
    const view = mountView(doc, mermaidExtension, { anchor: 0, focus: false });
    expect(flatten(view.state.field(mermaidField).decorations)).toEqual([]);
    const svg = await rendered(view);
    expect(svg.getAttribute('role')).toBe('img');
    expect(svg.getAttribute('aria-label')).toBe('Diagrama Mermaid: flowchart TD');
    expect(svg.hasAttribute('aria-labelledby')).toBe(false);
    expect(svg.hasAttribute('aria-describedby')).toBe(false);
    for (const label of ['Início', 'Decisão', 'Fim']) expect(svg.textContent).toContain(label);
    const [deco] = flatten(view.state.field(mermaidField).decorations);
    expect(deco?.block).toBe(true);
    expect(doc.slice(deco!.from, deco!.to)).toBe(flow);
  });

  it('cursor dentro (com foco) → fonte crua, 0 widgets; visitar cada linha não muda o texto', async () => {
    const view = mountView(DOC, mermaidExtension, { anchor: 0, focus: false });
    await rendered(view);
    view.focus();
    view.dispatch({ selection: { anchor: DOC.indexOf('A[Início]') } });
    await expect
      .poll(() => view.state.field(mermaidField).touched, { timeout: 15_000 })
      .toEqual([0]);
    expect(flatten(view.state.field(mermaidField).decorations)).toEqual([]);
    for (let n = 1; n <= view.state.doc.lines; n++) {
      view.dispatch({ selection: { anchor: view.state.doc.line(n).from } });
      await tick();
    }
    expect(view.state.doc.toString()).toBe(DOC);
  });

  it('fonte inválida → widget "Diagrama inválido: <mensagem>"; clique revela a fonte', async () => {
    const doc = 'x\n\n```mermaid\nflowchart TD\n  A[ -->\n```\n';
    const view = mountView(doc, mermaidExtension, { anchor: 0, focus: false });
    const error = await rendered(view, '[data-testid="mermaid-error"]');
    expect(error.classList.contains('cm-mermaid-error')).toBe(true);
    expect(error.textContent).toMatch(/^Diagrama inválido: .+/);
    expect(error.getAttribute('aria-hidden')).toBeNull();
    error.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    expect(view.state.selection.main.head).toBe(doc.indexOf('```mermaid'));
  });

  it('XSS: click … call alert e <img onerror> → 0 <script>, 0 on*, 0 javascript:, 0 alert', async () => {
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => undefined);
    const doc =
      '```mermaid\nflowchart TD\n  A["<img src=x onerror=alert(1)>"] --> B[b]\n  click A call alert(1)\n  click B "javascript:alert(1)"\n```\n\nfim\n';
    const view = mountView(doc, mermaidExtension, { anchor: doc.length, focus: false });
    const svg = await rendered(view);
    const all = [svg, ...svg.querySelectorAll('*')];
    expect(svg.querySelectorAll('script')).toHaveLength(0);
    expect(all.flatMap((el) => [...el.attributes].filter((a) => /^on/i.test(a.name)))).toEqual([]);
    expect(
      all.flatMap((el) => [...el.attributes].filter((a) => /javascript:/i.test(a.value))),
    ).toEqual([]);
    for (const el of svg.querySelectorAll('g, rect, text'))
      el.dispatchEvent(new MouseEvent('click'));
    expect(alert).not.toHaveBeenCalled();
    alert.mockRestore();
  });

  it('cache: edição fora → 0 renders; edição dentro → 1 render só depois do debounce de 300 ms', async () => {
    const view = mountView(DOC, mermaidExtension, { anchor: 0, focus: false });
    await rendered(view);
    await tick(MERMAID_DEBOUNCE_MS + 50);
    const start = mermaidRenderCounts.mermaid;
    for (const char of 'abc') view.dispatch({ changes: { from: 0, insert: char } });
    await tick(MERMAID_DEBOUNCE_MS + 100);
    expect(mermaidRenderCounts.mermaid).toBe(start);

    const inside = view.state.doc.toString().indexOf('C[Fim]') + 'C[Fim'.length;
    view.dispatch({ changes: { from: inside, insert: '!' } });
    await tick(100);
    expect(mermaidRenderCounts.mermaid).toBe(start);
    await tick(MERMAID_DEBOUNCE_MS + 200);
    expect(mermaidRenderCounts.mermaid).toBe(start + 1);
    await expect
      .poll(() => view.contentDOM.querySelector('.cm-mermaid svg')?.textContent)
      .toContain('Fim!');
  });

  it('tema: trocar as cores renderiza de novo; voltar usa o cache', async () => {
    const root = document.documentElement;
    root.style.setProperty('--color-bg', '#010101');
    const view = mountView(DOC, mermaidExtension, { anchor: 0, focus: false });
    await rendered(view);
    await tick(50);
    const start = mermaidRenderCounts.mermaid;
    root.style.setProperty('--color-bg', '#020202');
    await expect.poll(() => mermaidRenderCounts.mermaid, { timeout: 15_000 }).toBe(start + 1);
    root.style.setProperty('--color-bg', '#010101');
    await tick(100);
    expect(mermaidRenderCounts.mermaid).toBe(start + 1);
    root.style.removeProperty('--color-bg');
  });
});

/** Ids que um SVG referencia: `url(#…)` em qualquer atributo e `href`/`xlink:href` = `#…`. */
function references(svg: Element): string[] {
  return [svg, ...svg.querySelectorAll('*')].flatMap((el) =>
    [...el.attributes].flatMap(({ name, value }) => [
      ...[...value.matchAll(/url\(\s*['"]?#([^)'"\s]+)/g)].map((match) => match[1] ?? ''),
      ...(name.endsWith('href') && value.startsWith('#') ? [value.slice(1)] : []),
    ]),
  );
}

/** Um diagrama de cada tipo que o Mermaid desenha no jsdom (mindmap e architecture pedem canvas). */
const SAMPLES: Readonly<Record<string, string>> = {
  flowchart:
    'flowchart TD\n  A:::foo --> B{b}\n  classDef foo fill:#f96,stroke:#333\n  style B fill:#bbf\n  linkStyle 0 stroke:#f00',
  sequence:
    'sequenceDiagram\n  Alice->>Bob: Olá\n  Note right of Bob: nota\n  loop L\n    Bob-->>Alice: x\n  end',
  pie: 'pie showData title Itens\n  "a" : 1\n  "b" : 2',
  class: 'classDiagram\n  class Animal{\n    +int age\n    +isMammal()\n  }\n  Animal <|-- Duck',
  state:
    'stateDiagram-v2\n  [*] --> Still\n  Still --> Moving\n  classDef bad fill:#f00\n  class Moving bad',
  er: 'erDiagram\n  CUSTOMER ||--o{ ORDER : places',
  gantt: 'gantt\n  title A\n  dateFormat YYYY-MM-DD\n  section S\n  T1 :a1, 2024-01-01, 30d',
  journey: 'journey\n  title Dia\n  section Manhã\n    Café: 5: Eu',
  git: 'gitGraph\n  commit\n  branch dev\n  commit\n  checkout main\n  merge dev',
  timeline: 'timeline\n  title T\n  2020 : a\n  2021 : b',
  quadrant:
    'quadrantChart\n  title Q\n  x-axis Low --> High\n  y-axis Low --> High\n  A: [0.3, 0.6]',
  xy: 'xychart-beta\n  title "V"\n  x-axis [a, b]\n  y-axis "R" 0 --> 10\n  bar [5, 6]',
  sankey: 'sankey-beta\n  A,B,10\n  B,C,5',
  block: 'block-beta\n  columns 2\n  a b',
  packet: 'packet-beta\n  0-15: "Origem"\n  16-31: "Destino"',
  kanban: 'kanban\n  todo[A fazer]\n    t1[Tarefa]',
  radar: 'radar-beta\n  axis a, b, c\n  curve x{1, 2, 3}',
  treemap: 'treemap-beta\n  "A"\n    "B": 10\n    "C": 20',
  requirement: 'requirementDiagram\n  requirement r1 {\n    id: 1\n    text: t\n  }',
  c4: 'C4Context\n  Person(a, "A")\n  System(b, "B")\n  Rel(a, b, "usa")',
};

describe('F1/F7 (r38a2): a folha do diagrama só alcança o próprio SVG', { timeout: 30_000 }, () => {
  it('a folha real de cada tipo de diagrama passa no `scopedStyle` (nenhuma recusa falsa)', async () => {
    for (const [kind, source] of Object.entries(SAMPLES)) {
      const render = await renderMermaid(
        source,
        themeVariables(() => ''),
      );
      if (!render.ok) throw new Error(`${kind}: ${render.message}`);
      const template = document.createElement('template');
      template.innerHTML = render.svg;
      const styles = [...template.content.querySelectorAll('style')];
      expect(styles.length, kind).toBeGreaterThan(0);
      expect(styles.map(scopedStyle), kind).toEqual(styles.map(() => true));
    }
  });

  it('`%%{init}%%` não muda themeCSS, fontes nem htmlLabels no widget do editor', async () => {
    const doc = [
      '```mermaid',
      '%%{init: {"themeCSS": "@keyframes evil{from{opacity:0}} body{display:none}", "fontFamily": "x} @keyframes ff{} a{b:c", "altFontFamily": "y", "htmlLabels": true, "flowchart": {"htmlLabels": true}, "securityLevel": "loose"}}%%',
      'flowchart TD',
      '  A["<b>negrito</b>"] --> B',
      '```',
      '',
      'fim',
    ].join('\n');
    const view = mountView(doc, mermaidExtension, { anchor: doc.length, focus: false });
    const svg = await rendered(view);
    const styles = [...svg.querySelectorAll('style')];
    expect(styles.map(scopedStyle)).toEqual([true]);
    const css = styles[0]?.textContent ?? '';
    expect([...css.matchAll(/@keyframes ([\w-]+)/g)].map((match) => match[1])).toEqual([
      'edge-animation-frame',
      'dash',
    ]);
    expect(css).not.toMatch(/evil|ff\{|body\{|a\{b:c/);
    expect(svg.querySelectorAll('foreignObject')).toHaveLength(0);
  });

  it('B1/N3 (r38a2): `themeVariables` da nota (valor-array, `%%{init}%%` ou front matter) não chega à folha', async () => {
    // Como no app: todo token resolve (cor, fonte, tamanho).
    const vars = themeVariables((token) =>
      token === '--dimension-ui-font-size'
        ? '14px'
        : token === '--fontFamily-ui'
          ? 'system-ui'
          : '#336699',
    );
    // O Mermaid só confere os caracteres de valores string: um array entrava cru no template.
    const array = (value: string) => JSON.stringify([value]);
    const fixed = 'red} & {position:fixed;inset:0;z-index:2147483647;width:100vw;height:100vh';
    const flow = 'flowchart TD\n  A --> B';
    const hostile = {
      E1: `%%{init: {"theme": "base", "themeVariables": {"errorBkgColor": ${array(fixed)}}}}%%\n${flow}`,
      E2: `---\nconfig:\n  theme: base\n  themeVariables:\n    arrowheadColor: ${array(fixed)}\n---\n${flow}`,
      E3: `%%{init: {"theme": "base", "themeVariables": {"errorBkgColor": ${array('red} @keyframes dash{from{opacity:0}to{opacity:0}} & {fill:red')}}}}%%\n${flow}`,
      E4: `%%{init: {"theme": "base", "themeVariables": {"errorBkgColor": ${array('red} :root:has(&) body{display:none')}}}}%%\n${flow}`,
      E5: `%%{init: {"theme": "dark", "themeVariables": {"errorBkgColor": ${array(fixed)}}}}%%\n${flow}`,
      // A nota não recolore o diagrama (o custo da correção): a cor do app fica.
      L1: `%%{init: {"theme": "base", "themeVariables": {"primaryColor": "#ffcc00"}}}%%\n${flow}`,
    };
    const legit = {
      L2: 'flowchart TD\n  A:::foo --> B{b}\n  classDef foo fill:#f96,stroke:#333\n  style B fill:#bbf\n  linkStyle 0 stroke:#f00',
      L3: 'stateDiagram-v2\n  [*] --> Still\n  Still --> Moving\n  classDef bad fill:#f00\n  class Moving bad',
      L4: 'sequenceDiagram\n  Alice->>Bob: Olá\n  Note right of Bob: nota',
      L5: 'pie showData title Itens\n  "a" : 1\n  "b" : 2',
      L6: 'gantt\n  title A\n  dateFormat YYYY-MM-DD\n  section S\n  T1 :a1, 2024-01-01, 30d',
    };
    for (const [name, source] of Object.entries({ ...hostile, ...legit })) {
      const render = await renderMermaid(source, vars);
      if (!render.ok) throw new Error(`${name}: ${render.message}`);
      const host = document.createElement('div');
      host.innerHTML = render.svg;
      const svg = host.querySelector('svg');
      if (!svg) throw new Error(`${name}: sem SVG`);
      const styles = [...svg.querySelectorAll('style')];
      expect(styles.map(scopedStyle), name).toEqual([true]);
      const css = styles[0]?.textContent ?? '';
      expect(css, name).toContain('#336699');
      expect(css, name).not.toMatch(
        /position:fixed|2147483647|100vw|:root:has|display:none|#ffcc00/,
      );
      if (name in hostile) {
        // N3: `dash` continua o do Mermaid; a nota não o redefine para os outros diagramas.
        expect(
          [...css.matchAll(/@keyframes ([\w-]+)\{([^}]*)\}/g)].map((match) => match[0]),
        ).toEqual([
          '@keyframes edge-animation-frame{from{stroke-dashoffset:0;}',
          '@keyframes dash{to{stroke-dashoffset:0;}',
        ]);
      }
      // O widget do editor mantém a folha (nada a tirar).
      finishSvg(svg, 'Diagrama Mermaid: x');
      expect(svg.querySelectorAll('style'), name).toHaveLength(1);
    }
  });

  it('`finishSvg` tira a folha que sai do diagrama e mantém a que fica nele', () => {
    const host = document.body.appendChild(document.createElement('div'));
    host.innerHTML =
      '<svg id="mmd-00000000-1"><style>#mmd-00000000-1 .a{fill:red}</style><style>body{display:none}</style><g><style>#mmd-00000000-1 .b{fill:blue}</style></g></svg>';
    const svg = host.querySelector('svg');
    if (!svg) throw new Error('sem SVG');
    finishSvg(svg, 'Diagrama Mermaid: x');
    expect([...svg.querySelectorAll('style')].map((style) => style.textContent)).toEqual([
      '#mmd-00000000-1 .a{fill:red}',
      '#mmd-00000000-1 .b{fill:blue}',
    ]);
  });

  it('E1 (F7): widget do editor e prévia do mesmo diagrama não dividem nenhum id', async () => {
    // O fluxograma do FX-RICH (a evidência E1 da r38b); a sequência e o sankey têm ids sem o prefixo
    // do diagrama (`actor<n>`, `root-<n>`, `linearGradient-<n>`), contados no módulo do Mermaid: cada
    // renderização tem os seus, e as do sankey são referenciadas por `url(#…)`.
    for (const source of [
      'flowchart TD\n  A[Início] --> B{Decisão}\n  B -->|sim| C[Fim]\n  B -->|não| A\n  %% E1',
      'sequenceDiagram\n  Alice->>Bob: Olá\n  %% E1',
      'sankey-beta\n  A,B,10\n  B,C,5\n  C,D,2',
    ]) {
      const doc = `\`\`\`mermaid\n${source}\n\`\`\`\n\nfim\n`;
      const view = mountView(doc, mermaidExtension, { anchor: doc.length, focus: false });
      const widget = await rendered(view);
      const preview = document.body.appendChild(document.createElement('div'));
      preview.innerHTML =
        (await renderMermaidMarkup(
          source,
          themeVariables(() => ''),
        )) ?? '';
      const copy = preview.querySelector('svg');
      if (!copy) throw new Error(`sem SVG: ${source}`);
      const copyIds = new Set([...copy.querySelectorAll('[id]')].map((el) => el.id));
      const ids = [widget, ...widget.querySelectorAll('[id]')].map((el) => el.id);
      expect(
        ids.filter((id) => copyIds.has(id) || id === copy.id),
        source,
      ).toEqual([]);
      for (const svg of [widget, copy]) {
        expect([...svg.querySelectorAll('style')].map(scopedStyle), source).toEqual([true]);
        // Toda referência por id resolve dentro do próprio SVG (nenhuma vai parar no outro).
        for (const id of references(svg))
          expect(svg.contains(document.getElementById(id)), id).toBe(true);
      }
    }
  });
});

/** Tokens embutidos (`@simplemd/themes`, fora das dependências deste pacote), lidos das fontes. */
const THEMES_SRC = join(__dirname, '../../themes/src');
const LIGHT: Readonly<Record<string, string>> = Object.fromEntries(
  [...readFileSync(join(THEMES_SRC, 'tokens.css'), 'utf8').matchAll(/(--[\w-]+):\s*([^;]+);/g)].map(
    ([, name = '', value = '']) => [name, value.trim()],
  ),
);
// Arquivo do próprio repositório (fixture de teste): forma conhecida, sem validação.
const darkTheme: { readonly tokens: Readonly<Record<string, string>> } = JSON.parse(
  readFileSync(join(THEMES_SRC, 'builtin/simplemd-dark.json'), 'utf8'),
);
const DARK: Readonly<Record<string, string>> = { ...LIGHT, ...darkTheme.tokens };

/** Canais de `#rrggbb`, `rgb(…)`, `hsl(…)` (o khroma do Mermaid escreve os dois) ou `black`/`white`. */
function channels(color: string): [number, number, number] {
  const text = color.trim();
  if (text === 'black') return [0, 0, 0];
  if (text === 'white') return [255, 255, 255];
  if (/^#[0-9a-f]{6}$/i.test(text))
    return [1, 3, 5].map((i) => Number.parseInt(text.slice(i, i + 2), 16)) as [
      number,
      number,
      number,
    ];
  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(text);
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  const hsl = /^hsla?\(\s*([\d.]+)[\s,]+([\d.]+)%[\s,]+([\d.]+)%/.exec(text);
  if (!hsl) throw new Error(`cor não reconhecida: ${color}`);
  const [h, s, l] = [Number(hsl[1]), Number(hsl[2]) / 100, Number(hsl[3]) / 100];
  const a = s * Math.min(l, 1 - l);
  return [0, 8, 4].map((n) => {
    const k = (n + h / 30) % 12;
    return 255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)));
  }) as [number, number, number];
}

/** Luminância relativa WCAG 2.x. */
function luminance(color: string): number {
  const [r, g, b] = channels(color).map((c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Razão WCAG truncada em 2 casas (2,999 reprova). */
function ratio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return Math.floor(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
}

/** Valores de `prop` nas regras da folha compacta (stylis) com um seletor terminado em `selector`. */
function declarations(css: string, selector: string, prop: string): string[] {
  return [...css.matchAll(/([^{}]*)\{([^{}]*)\}/g)]
    .filter(([, selectors = '']) => selectors.split(',').some((s) => s.trim().endsWith(selector)))
    .flatMap(([, , body = '']) =>
      [...body.matchAll(new RegExp(`(?:^|;)${prop}:([^;]+)`, 'g'))].map((m) => m[1]!.trim()),
    );
}

describe('B-2 (r42): diagramas seguem os tokens (WCAG 1.4.11 e 1.4.3)', { timeout: 30_000 }, () => {
  it.each([
    ['claro', LIGHT],
    ['escuro', DARK],
  ])('%s: traços e nós ≥ 3:1 sobre o fundo; rótulos ≥ 4,5:1 sobre o nó', async (_, tokens) => {
    const vars = themeVariables((token) => tokens[token] ?? '');
    const bg = tokens['--color-bg']!;
    expect(vars.background).toBe(bg);
    // Arestas, setas e bordas de grupo/serviço do architecture-beta (o jsdom não o desenha).
    for (const name of ['archEdgeColor', 'archEdgeArrowColor', 'archGroupBorderColor']) {
      expect(vars[name], name).toBe(tokens['--color-muted']);
      expect(ratio(vars[name]!, bg), name).toBeGreaterThanOrEqual(3);
    }
    // Raiz do mindmap (`git0`) e contorno do commit destacado (`gitInv0`).
    expect(vars.git0).toBe(tokens['--color-accent']);
    expect(ratio(vars.git0!, bg)).toBeGreaterThanOrEqual(3);
    expect(ratio(vars.gitBranchLabel0!, vars.git0!)).toBeGreaterThanOrEqual(4.5);
    expect(ratio(vars.gitInv0!, bg)).toBeGreaterThanOrEqual(3);
    // Seções do mindmap (o jsdom não o desenha): nó e linha sobre o fundo, texto e linha sobre o nó.
    for (let i = 0; i < 12; i++) {
      const [fill, label, line] = ['cScale', 'cScaleLabel', 'cScaleInv'].map((v) => vars[v + i]);
      expect([fill, label, line], `seção ${i}`).not.toContain(undefined);
      expect(ratio(fill!, bg), `cScale${i}`).toBeGreaterThanOrEqual(3);
      expect(ratio(line!, bg), `cScaleInv${i}`).toBeGreaterThanOrEqual(3);
      expect(ratio(label!, fill!), `cScaleLabel${i}`).toBeGreaterThanOrEqual(4.5);
      expect(ratio(line!, fill!), `cScaleInv${i}`).toBeGreaterThanOrEqual(3);
    }
    // A folha real do timeline e do kanban (o kanban clareia ou escurece a coluna 10 %).
    const sheet = async (source: string) => {
      const render = await renderMermaid(source, vars);
      if (!render.ok) throw new Error(render.message);
      return /<style>([\s\S]*?)<\/style>/.exec(render.svg)?.[1] ?? '';
    };
    const timeline = await sheet(SAMPLES.timeline!);
    const axis = declarations(timeline, '.lineWrapper line', 'stroke');
    expect(axis.length).toBeGreaterThan(0);
    expect(ratio(axis.at(-1)!, bg), 'eixo do timeline').toBeGreaterThanOrEqual(3);
    const kanban = await sheet(SAMPLES.kanban!);
    for (const [name, css] of [
      ['timeline', timeline],
      ['kanban', kanban],
    ] as const) {
      for (let i = -1; i < 11; i++) {
        const fills = declarations(css, `.section-${i} rect`, 'fill');
        const texts = declarations(css, `.section-${i} text`, 'fill');
        expect(fills.length * texts.length, `${name} ${i}`).toBeGreaterThan(0);
        for (const fill of fills)
          for (const text of texts)
            expect(ratio(text, fill), `${name} ${i}: ${text} sobre ${fill}`).toBeGreaterThanOrEqual(
              4.5,
            );
      }
    }
    // gitGraph: o rótulo de cada ramo sobre a cor dele, no tema que o Mermaid calculou.
    const theme: Readonly<Record<string, string>> = (await loadMermaid()).mermaidAPI.getSiteConfig()
      .themeVariables;
    for (let i = 0; i < 8; i++)
      expect(
        ratio(theme[`gitBranchLabel${i}`]!, theme[`git${i}`]!),
        `gitBranchLabel${i}`,
      ).toBeGreaterThanOrEqual(4.5);
  });
});
