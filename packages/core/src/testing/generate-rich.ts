/** PRNG mulberry32 (o mesmo do gerador grande): determinístico para a mesma semente. */
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
  'soma',
  'área',
  'raio',
  'tempo',
  'massa',
];

/** Contagens do `rich-10k.md` (product r2 §3, NFR-21b). */
export const RICH_COUNTS = {
  lines: 10_000,
  mermaid: 20,
  inlineMath: 300,
  blockMath: 50,
  calc: 100,
  tables: 50,
} as const;

/**
 * Gera o `rich-10k.md` (NFR-21b, NFR-23): exatamente `RICH_COUNTS.lines` linhas, com 20 diagramas
 * Mermaid (≤ 30 nós cada), 300 fórmulas em linha, 50 blocos `$$`, 100 expressões calc e 50 tabelas
 * GFM, espalhados entre parágrafos de prosa. Determinístico pela semente (fixture de PERF/QA).
 */
export function generateRichMarkdown(seed = 7): string {
  const random = mulberry32(seed);
  const word = () => WORDS[Math.floor(random() * WORDS.length)] ?? 'texto';
  const prose = (n: number) => Array.from({ length: n }, word).join(' ');
  const units: string[][] = [];
  for (let i = 0; i < RICH_COUNTS.mermaid; i++) {
    const nodes = 10 + (i % 21);
    const lines = ['', '```mermaid', 'flowchart TD'];
    for (let n = 1; n < nodes; n++) lines.push(`  N${n}[${word()} ${n}] --> N${n + 1}[${word()}]`);
    lines.push('```', '');
    units.push(lines);
  }
  for (let i = 0; i < RICH_COUNTS.blockMath; i++) {
    units.push(['', '$$', `\\sum_{k=1}^{${i + 2}} k^2 = \\frac{n(n+1)(2n+1)}{6}`, '$$', '']);
  }
  for (let i = 0; i < RICH_COUNTS.tables; i++) {
    units.push([
      '',
      '| Item | Valor |',
      '| --- | ---: |',
      `| ${word()} | ${i} |`,
      `| ${word()} | ${i + 1} |`,
      '',
    ]);
  }
  // 300 fórmulas e 100 calc em 100 parágrafos de uma linha (3 fórmulas + 1 calc cada).
  for (let i = 0; i < RICH_COUNTS.calc; i++) {
    units.push([
      '',
      `${prose(3)} $x_${i}^2$ ${prose(2)} $\\alpha + ${i}$ e $\\sqrt{${i + 1}}$ total =${i}+${i + 1}*2`,
      '',
    ]);
  }
  // Cada unidade começa e termina com uma linha em branco (blocos separados da prosa). Embaralha as
  // unidades (Fisher-Yates) e preenche o resto com prosa até a contagem exata de linhas.
  for (let i = units.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [units[i], units[j]] = [units[j]!, units[i]!];
  }
  const fixed = units.reduce((sum, unit) => sum + unit.length, 2);
  const fillers = RICH_COUNTS.lines - fixed;
  const out: string[] = ['# Documento rico de 10.000 linhas', ''];
  const perGap = Math.floor(fillers / (units.length + 1));
  let remaining = fillers;
  for (const unit of units) {
    for (let k = 0; k < perGap; k++, remaining--) out.push(k % 4 === 3 ? '' : prose(8 + (k % 5)));
    out.push(...unit);
  }
  for (let k = 0; remaining > 0; k++, remaining--) out.push(k % 4 === 3 ? '' : prose(8));
  return out.join('\n');
}
