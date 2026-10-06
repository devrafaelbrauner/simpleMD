/** PRNG mulberry32: determinístico para a mesma semente. */
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
  'markdown',
  'vault',
  'nota',
  'editor',
  'texto',
  'tema',
  'arquivo',
  'pasta',
  'cursor',
  'linha',
  'bloco',
  'tabela',
  'lista',
  'título',
  'código',
  'disco',
];

/**
 * Gera um documento markdown grande e determinístico com exatamente `lines` linhas (sem `\n`
 * final), misturando os elementos do live preview: títulos, parágrafos com ênfase e links,
 * listas, blocos de código cercados e tabelas GFM. Usado pela demo em `?doc=large` (NFR-5:
 * 10.000 linhas, cerca de 400 KB).
 */
export function generateLargeMarkdown(lines: number, seed = 1): string {
  const random = mulberry32(seed);
  const pick = (): string => WORDS[Math.floor(random() * WORDS.length)] ?? 'texto';
  const sentence = (n: number): string => Array.from({ length: n }, pick).join(' ');
  const blocks: Array<() => string[]> = [
    () => [`${'#'.repeat(1 + Math.floor(random() * 6))} ${sentence(5)}`, ''],
    () => [
      `${sentence(8)} **${sentence(3)}** ${sentence(6)} *${sentence(3)}* [${pick()}](https://exemplo.com/${pick()}) ${sentence(8)}.`,
      '',
    ],
    () => [`- ${sentence(7)}`, `  - ${sentence(6)}`, `- ${sentence(8)}`, ''],
    () => [`1. ${sentence(7)}`, `2. ${sentence(6)}`, ''],
    () => ['```ts', `const ${pick()} = '${sentence(6)}';`, '```', ''],
    () => [
      `| ${sentence(2)} | ${sentence(2)} | ${sentence(2)} |`,
      '| :--- | :---: | ---: |',
      `| ${sentence(3)} | ${sentence(3)} | ${sentence(3)} |`,
      '',
    ],
  ];
  const out: string[] = [];
  while (out.length < lines) {
    const block = blocks[Math.floor(random() * blocks.length)] ?? blocks[0];
    const chunk = block ? block() : [];
    if (out.length + chunk.length > lines) {
      while (out.length < lines) out.push(sentence(6));
      break;
    }
    out.push(...chunk);
  }
  return out.join('\n');
}
