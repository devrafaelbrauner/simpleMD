/**
 * Gerador do `rich-r7-10k.md` (product r7 §6; NFR-41 (b), NFR-43, PERF-1…4). Puro e sem imports
 * (como os outros geradores), determinístico pela semente. As imagens apontam para os arquivos
 * `img/*` do vault `FX-R7` do harness.
 */

/** PRNG mulberry32 (o mesmo dos outros geradores). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = [
  'nota',
  'texto',
  'linha',
  'bloco',
  'valor',
  'prosa',
  'ideia',
  'tempo',
  'lista',
  'mapa',
];

/** Contagens exatas do `rich-r7-10k.md` (product r7 §6). */
export const RICH_R7_COUNTS = {
  lines: 10_000,
  /** 200 em linha, 100 autolinks, 100 URLs GFM, 100 de referência. */
  links: 500,
  wikilinks: 300,
  tasks: 300,
  strikethroughs: 200,
  inlineCodes: 300,
  quotes: 100,
  images: 50,
  htmlBlocks: 100,
  tables: 50,
  queries: 20,
} as const;

/** Imagens do `FX-R7` (os 5 tipos), em ciclo. */
const IMAGES = [
  'img/bandeira.png',
  'img/foto.jpg',
  'img/anim.gif',
  'img/imagem.webp',
  'img/desenho.svg',
];
const SIGNS = [
  '📅 2026-11-05',
  '⏫',
  '🔁 every week',
  '⏳ 2026-10-20',
  '#trabalho',
  '🛫 2026-10-12',
];
const REFS = 10;

/**
 * Gera o documento: exatamente `RICH_R7_COUNTS.lines` linhas, com cada contagem acima espalhada
 * em unidades embaralhadas entre parágrafos de prosa. Mesma semente → mesmos bytes.
 */
export function generateRichR7Markdown(seed = 7): string {
  const random = mulberry32(seed);
  const word = () => WORDS[Math.floor(random() * WORDS.length)] ?? 'texto';
  const prose = (n: number) => Array.from({ length: n }, word).join(' ');
  const units: string[][] = [];
  // 100 parágrafos × 5 links: 2 em linha (um com título), 1 autolink, 1 URL GFM, 1 de referência.
  for (let i = 0; i < 100; i++) {
    units.push([
      '',
      `${prose(2)} [${word()}](https://exemplo.org/p/${i}) ${word()} [${word()}](https://exemplo.org/t/${i} "Título ${i}") <https://exemplo.org/auto/${i}> e https://exemplo.org/gfm/${i} com [${word()}][ref-${i % REFS}].`,
      '',
    ]);
  }
  // 100 linhas × 3 wikilinks.
  for (let i = 0; i < 100; i++) {
    units.push([
      '',
      `${prose(2)} [[Bolo]] ${word()} [[Nota|apelido ${i}]] e [[receitas/Bolo#Cobertura]].`,
      '',
    ]);
  }
  // 100 linhas × (3 códigos em linha + 2 tachados).
  for (let i = 0; i < 100; i++) {
    units.push([
      '',
      `${word()} \`codigo${i}\` ${word()} ~~riscado ${i}~~ \`x = ${i}\` ${word()} ~~${word()}~~ \`fim\`.`,
      '',
    ]);
  }
  // 30 listas × 10 tarefas com sinais.
  for (let i = 0; i < 30; i++) {
    const list = [''];
    for (let k = 0; k < 10; k++) {
      const status = (i + k) % 4 === 0 ? 'x' : ' ';
      list.push(`- [${status}] ${prose(4)} ${SIGNS[(i + k) % SIGNS.length]}`);
    }
    list.push('');
    units.push(list);
  }
  // 100 citações (1 a 3 níveis).
  for (let i = 0; i < RICH_R7_COUNTS.quotes; i++) {
    units.push(['', `${'> '.repeat(1 + (i % 3))}${prose(6)}`, '']);
  }
  // 50 imagens de bloco (sozinhas no parágrafo).
  for (let i = 0; i < RICH_R7_COUNTS.images; i++) {
    units.push(['', `![imagem ${i}](${IMAGES[i % IMAGES.length]})`, '']);
  }
  // 100 blocos HTML sem linha em branco dentro (um bloco cada; um vetor removido a cada 10).
  for (let i = 0; i < RICH_R7_COUNTS.htmlBlocks; i++) {
    units.push(
      i % 2 === 0
        ? ['', '<details>', `<summary>Resumo ${i}</summary>`, prose(5), '</details>', '']
        : [
            '',
            `<p>Tecla <kbd>Ctrl</kbd> e <mark>${word()}</mark>${i % 10 === 1 ? ' <img src=x onerror="window.__xss=1">' : ''}</p>`,
            '',
          ],
    );
  }
  // 50 tabelas 3 × 3.
  for (let i = 0; i < RICH_R7_COUNTS.tables; i++) {
    units.push([
      '',
      '| Item | Valor | Nota |',
      '| --- | ---: | :-: |',
      `| ${word()} | ${i} | 中文 |`,
      `| ${word()} | ${i + 1} | ação |`,
      '',
    ]);
  }
  // 20 consultas: 10 tasks + 10 dataview.
  for (let i = 0; i < RICH_R7_COUNTS.queries; i++) {
    units.push(
      i % 2 === 0
        ? ['', '```tasks', 'not done', `limit ${5 + i}`, '```', '']
        : ['', '```dataview', 'TASK', 'WHERE !completed', `LIMIT ${5 + i}`, '```', ''],
    );
  }
  for (let i = units.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [units[i], units[j]] = [units[j]!, units[i]!];
  }
  const definitions = Array.from(
    { length: REFS },
    (_, i) => `[ref-${i}]: https://exemplo.org/ref/${i} "Referência ${i}"`,
  );
  const head = ['# Documento rico do r7 (10.000 linhas)', ''];
  const tail = ['', ...definitions];
  const fixed = units.reduce((sum, unit) => sum + unit.length, head.length + tail.length);
  const fillers = RICH_R7_COUNTS.lines - fixed;
  const out: string[] = [...head];
  const perGap = Math.floor(fillers / (units.length + 1));
  let remaining = fillers;
  for (const unit of units) {
    for (let k = 0; k < perGap; k++, remaining--) out.push(k % 4 === 3 ? '' : prose(8 + (k % 5)));
    out.push(...unit);
  }
  for (let k = 0; remaining > 0; k++, remaining--) out.push(k % 4 === 3 ? '' : prose(8));
  out.push(...tail);
  return out.join('\n');
}
