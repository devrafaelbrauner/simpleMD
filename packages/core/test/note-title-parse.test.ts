import { markdownLanguage } from '@codemirror/lang-markdown';
import type { MarkdownParser } from '@lezer/markdown';
import { describe, expect, it } from 'vitest';
import { frontMatterSyntax } from '../src/frontmatter/lezer';
import { headingLevel, headingText, NO_HEADING_BLOCKS } from '../src/metadata/heading';
import { extractNoteMeta, firstHeading1, headingParseCounts } from '../src/metadata/note';
import { PERF_GATE } from './helpers/perf';

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

/**
 * Menor de 7 execuções (comparação relativa no mesmo processo; TA-R2-16). O mínimo é o que menos
 * sofre com carga de outros processos e coleta de lixo: ruído só aumenta tempos, nunca diminui.
 */
function fastest(run: () => unknown): number {
  let best = Infinity;
  for (let i = 0; i < 7; i++) {
    const start = performance.now();
    run();
    best = Math.min(best, performance.now() - start);
  }
  return best;
}

/**
 * Formas com um bloco folha gigante (R4-01, revisão de 00e71df): o Lezer consome o bloco inteiro
 * numa janela só, e a versão anterior o re-analisava a cada janela (~5× um parse completo).
 */
function giantBlockShapes(lines: number): Record<string, string> {
  const prose = Array.from(
    { length: lines },
    (_, i) => `linha ${i} de prosa corrida sem linha em branco`,
  ).join('\n');
  const quoted = prose.replace(/^/gm, '> ');
  return {
    'prosa de linhas simples, "## " no topo': `## Diário\n\n${prose}\n`,
    'prosa de linhas simples, H1 no fim': `${prose}\n\n# Fim\n`,
    'thread citada, sem H1': `## Re: assunto\n\n${quoted}\n`,
    'nota inteira num item de lista, H1 dentro': `- ${prose.replace(/\n/g, '\n  ')}\n  # Dentro\n`,
    'data: numa linha, depois H1': `![img](data:image/png;base64,${'A'.repeat(lines * 40)})\n\n# Depois\n`,
    'cerca de código gigante, depois H1': `\`\`\`\n${'# não é título\n'.repeat(lines)}\`\`\`\n\n# Depois\n`,
  };
}

// Tempo limite explícito (TA-R2-16/TA-R2-18): notas de 120–450 KB e, na perna de cobertura v8 do CI,
// cada análise completa de referência fica várias vezes mais lenta. Nenhuma asserção usa ms absolutos.
describe(
  'PERF-R2-01: título sem analisar a nota inteira, mesma regra (R-9.3)',
  { timeout: 60_000 },
  () => {
    // ~120 KB por caso: cruza as janelas de 4, 16 e 64 KB.
    it('mesmo resultado da análise completa em casos de borda e nas fronteiras das janelas', () => {
      const big = filler(3_000);
      const cases: string[] = [
        '# Topo\n\n' + big,
        big + '\n\n# Lá no fim\n',
        filler(2_700) + '\n\nTítulo setext tardio\n===\n\n' + filler(300, 3),
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
        ...Object.values(giantBlockShapes(2_500)),
        // Parágrafo gigante que termina num sublinhado setext: ele inteiro é o H1.
        `${'linha\n'.repeat(3_000)}===\n\n# depois\n`,
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
      // O espião soma `tree.length` (até onde o parser foi): a janela de 4 KB + o fim do último bloco.
      expect(headingParseCounts.chars - before).toBeLessThanOrEqual(8192);
    });

    // R5-01 (AC-B15.4): um bloco pequeno que cruza a borda não leva mais ao parse completo; a janela
    // seguinte (4×) é usada. O espião soma todas as rodadas: ≤ janelas usadas + o bloco que cruza
    // cada borda (D-C2). Cada parágrafo aqui tem < 64 caracteres.
    const smallBlocks = (h1At: number) => {
      const para = (i: number) => `Parágrafo ${i} curto de texto.\n\n`;
      let head = '';
      for (let i = 0; head.length < h1At; i++) head += para(i);
      let tail = '';
      for (let i = 0; tail.length < 400_000; i++) tail += para(i);
      return `${head}# Título aos ${h1At}\n\n${tail}`;
    };

    it('R5-01: H1 a ~8 KB depois de blocos pequenos → janelas de 4 KB e 16 KB, não a nota inteira', () => {
      const text = smallBlocks(8_000);
      const before = headingParseCounts.chars;
      expect(firstHeading1(text)).toBe('Título aos 8000');
      expect(referenceHeading1(text)).toBe('Título aos 8000');
      expect(headingParseCounts.chars - before).toBeLessThanOrEqual(4096 + 16384 + 2 * 64);
    });

    it('R5-01: H1 a ~40 KB depois de blocos pequenos → a janela de 64 KB é usada', () => {
      const text = smallBlocks(40_000);
      const before = headingParseCounts.chars;
      expect(firstHeading1(text)).toBe('Título aos 40000');
      expect(referenceHeading1(text)).toBe('Título aos 40000');
      const work = headingParseCounts.chars - before;
      expect(work).toBeGreaterThan(4096 + 16384 + 2 * 64);
      expect(work).toBeLessThanOrEqual(4096 + 16384 + 65536 + 3 * 64);
    });

    it('guarda da tarefa longa: com H1 no início, o título custa < 1/5 de analisar a nota inteira', () => {
      // Medido em máquina sem carga: ~0,5 ms contra ~40 ms; a margem de 5× absorve carga e coleta de lixo.
      const text = `# Diário\n\n${filler(5_000)}`;
      const full = fastest(() => parser.parse(text));
      const title = fastest(() => firstHeading1(text));
      expect(title).toBeLessThan(full / 5);
    });

    it('H1 só no fim (a regra exige achá-lo): trabalho de parse < 2× o documento', () => {
      const text = `${filler(10_000)}\n\n# Conclusão\n`;
      const before = headingParseCounts.chars;
      expect(firstHeading1(text)).toBe('Conclusão');
      expect(headingParseCounts.chars - before).toBeLessThan(2 * text.length);
    });

    it('R4-01: bloco folha gigante não é re-analisado a cada janela (trabalho ≤ 2× o documento)', () => {
      for (const [name, text] of Object.entries(giantBlockShapes(6_000))) {
        const before = headingParseCounts.chars;
        expect(firstHeading1(text), name).toBe(referenceHeading1(text));
        // A versão anterior somava ~5× aqui (4 KB, 16 KB, 64 KB, 256 KB, inteiro, cada um com o bloco).
        expect(headingParseCounts.chars - before, name).toBeLessThanOrEqual(2 * text.length + 1);
      }
    });

    // TA-R2-19: mesmo relativa, a comparação de tempo falhou em 7 de 30 suítes embaralhadas (CPU
    // disputada). O teste de trabalho acima é a garantia determinística; este só roda no portão.
    it.runIf(PERF_GATE)(
      'R4-01: guarda relativa de tempo — nas formas de bloco gigante o título custa < 3× um parse',
      () => {
        // Medido (menor de 7, sem carga): antes 3,9–4,1×, agora 2,0–2,1×. Só as formas cujo parse
        // completo leva vários ms; `data:` e a cerca (< 1 ms) ficam no teste de trabalho acima.
        const shapes = Object.entries(giantBlockShapes(3_000)).slice(0, 4);
        for (const [name, text] of shapes) {
          const full = fastest(() => parser.parse(text));
          const title = fastest(() => firstHeading1(text));
          expect(
            title,
            `${name}: título ${title.toFixed(1)} ms, parse ${full.toFixed(1)} ms`,
          ).toBeLessThan(3 * full);
        }
      },
    );

    it('extractNoteMeta mantém a ordem front matter > H1 > nome do arquivo', () => {
      const body = filler(5_000);
      expect(extractNoteMeta(`---\ntitle: Do YAML\n---\n# H1\n${body}`, 'a.md').title).toBe(
        'Do YAML',
      );
      expect(extractNoteMeta(`${body}\n# Tardio\n`, 'p/a.md').title).toBe('Tardio');
      expect(extractNoteMeta(body, 'p/Sem Título.md').title).toBe('Sem Título');
    });
  },
);
