import { markdownLanguage } from '@codemirror/lang-markdown';
import type { MarkdownParser } from '@lezer/markdown';
import { describe, expect, it } from 'vitest';
import { frontMatterSyntax } from '../src/frontmatter/lezer';
import { headingLevel, headingText, NO_HEADING_BLOCKS } from '../src/metadata/heading';
import { extractNoteMeta, firstHeading1, headingParseCounts } from '../src/metadata/note';

/** Referência: a regra antiga, com o documento inteiro analisado de uma vez. */
const parser = (markdownLanguage.parser as MarkdownParser).configure([frontMatterSyntax]);
function referenceHeading1(text: string): string | null {
  let found: string | null = null;
  parser.parse(text).iterate({
    enter(node) {
      if (found !== null || NO_HEADING_BLOCKS[node.name]) return false;
      if (headingLevel(node.name) === 1) {
        found = headingText(text.slice(node.from, node.to), node.name);
        return false;
      }
      return undefined;
    },
  });
  return found || null;
}

/** Corpo grande: parágrafos, listas, código cercado com comentários `# …` e títulos H2. */
function filler(lines: number, seed = 0): string {
  const out: string[] = [];
  for (let i = 0; out.length < lines; i++) {
    const n = i + seed;
    if (n % 40 === 7) out.push('```bash', '# comentário, não título', 'echo oi', '```', '');
    else if (n % 25 === 3) out.push(`## Seção ${n}`, '');
    else if (n % 11 === 5) out.push(`- item ${n} com *ênfase*`, `- outro item ${n}`, '');
    else out.push(`Linha ${n} de texto comum com [link](https://x.y) e \`código\`.`);
  }
  return out.slice(0, lines).join('\n');
}

describe('PERF-R2-01: título sem analisar a nota inteira, mesma regra (R-9.3)', () => {
  it('mesmo resultado da análise completa em casos de borda e nas fronteiras das janelas', () => {
    const big = filler(10_000);
    const cases: string[] = [
      '# Topo\n\n' + big,
      big + '\n\n# Lá no fim\n',
      filler(9_000) + '\n\nTítulo setext tardio\n===\n\n' + filler(900, 3),
      // Código cercado aberto antes da 1ª janela e fechado depois: o `#` de dentro não é título.
      'texto\n\n```\n' + '# dentro do código\n'.repeat(800) + '```\n\n# Depois do código\n',
      '---\ntitle: x\n---\n' + big,
      big,
      '## só H2\n\n' + big.replace(/^# .*$/gm, ''),
      '   # indentado 3 espaços conta\n' + big,
      '    # indentado 4 é código\n\n' + big + '\n# Final\n',
      '#\n\n# segundo\n',
      '> # Dentro de citação\n\n' + big,
      'sem cerquilha nem igual',
    ];
    // Setext cuja linha de sublinhado cai logo depois de cada fronteira de janela (4 KB, 16 KB, 64 KB).
    for (const edge of [4096, 16384, 65536]) {
      const head = 'a'.repeat(edge - 3) + '\n\n';
      cases.push(head + 'Título\n===\n' + big);
      cases.push(head.slice(0, -1) + 'Título\n=====\n' + big);
    }
    for (const text of cases)
      expect(firstHeading1(text), text.slice(0, 60)).toBe(referenceHeading1(text));
  });

  it('H1 no início de uma nota de 10 mil linhas: só a primeira janela é analisada', () => {
    const text = `# Diário\n\n${filler(10_000)}`;
    expect(text.length).toBeGreaterThan(400_000);
    const before = headingParseCounts.chars;
    expect(firstHeading1(text)).toBe('Diário');
    expect(headingParseCounts.chars - before).toBeLessThanOrEqual(4096);
  });

  it('guarda da tarefa longa: com H1 no início, o título custa < 1/5 de analisar a nota inteira', () => {
    // Comparação relativa no mesmo processo (TA-R2-16: nenhum orçamento absoluto em ms). Medido em
    // máquina sem carga: ~0,5 ms contra ~40 ms; a margem de 5× absorve carga e coleta de lixo.
    const text = `# Diário\n\n${filler(10_000)}`;
    const median = (run: () => unknown) => {
      const times: number[] = [];
      for (let i = 0; i < 5; i++) {
        const start = performance.now();
        run();
        times.push(performance.now() - start);
      }
      return times.sort((a, b) => a - b)[2]!;
    };
    const full = median(() => parser.parse(text));
    const title = median(() => firstHeading1(text));
    expect(title).toBeLessThan(full / 5);
  });

  it('H1 só no fim: acha (a regra exige) cobrindo o documento uma vez, com a árvore reaproveitada', () => {
    const text = `${filler(10_000)}\n\n# Conclusão\n`;
    const before = headingParseCounts.chars;
    expect(firstHeading1(text)).toBe('Conclusão');
    expect(headingParseCounts.chars - before).toBe(text.length);
  });

  it('extractNoteMeta mantém a ordem front matter > H1 > nome do arquivo', () => {
    const body = filler(5_000);
    expect(extractNoteMeta(`---\ntitle: Do YAML\n---\n# H1\n${body}`, 'a.md').title).toBe(
      'Do YAML',
    );
    expect(extractNoteMeta(`${body}\n# Tardio\n`, 'p/a.md').title).toBe('Tardio');
    expect(extractNoteMeta(body, 'p/Sem Título.md').title).toBe('Sem Título');
  });
});
