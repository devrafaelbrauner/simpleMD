// r7 S0 (product r7 §6): o vault FX-R7 do harness e os presets novos têm exatamente o que as
// fatias e a QA esperam — 5 tipos de imagem com os bytes certos, recusas, limites gerados na hora,
// 200 tarefas, consultas de referência, backlinks do Bolo e notas byte a byte.
import { describe, expect, test } from 'vitest';
import { PRESETS } from '../harness/fixtures';
import {
  FX_R7_BOLO_SOURCES,
  FX_R7_LIMITS,
  FX_R7_TASKS,
  fxR7,
  oversizeImage,
} from '../harness/fixtures/r7';

const vault = fxR7();
const text = (path: string) => {
  const value = vault[path];
  if (typeof value !== 'string') throw new Error(`${path} não é texto`);
  return value;
};
const head = (path: string, n: number) => {
  const value = vault[path];
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  return Array.from(bytes?.subarray(0, n) ?? []);
};
const ascii = (s: string) => Array.from(s, (c) => c.charCodeAt(0));
const notes = Object.keys(vault).filter((p) => p.endsWith('.md'));

describe('FX-R7: imagens (AC-I1.6…AC-I1.10)', () => {
  test('os 5 tipos têm a assinatura do próprio formato', () => {
    expect(head('img/bandeira.png', 8)).toEqual([0x89, ...ascii('PNG\r\n'), 0x1a, 0x0a]);
    expect(head('img/foto.jpg', 3)).toEqual([0xff, 0xd8, 0xff]);
    expect(head('img/anim.gif', 6)).toEqual(ascii('GIF87a'));
    const webp = head('img/imagem.webp', 12);
    expect([webp.slice(0, 4), webp.slice(8, 12)]).toEqual([ascii('RIFF'), ascii('WEBP')]);
    expect(head('img/desenho.svg', 4)).toEqual(ascii('<svg'));
    expect(vault['img/com espaços.png']).toEqual(vault['img/bandeira.png']);
  });

  test('bytes trocados: extensão .png sem assinatura PNG; .bmp fora dos tipos', () => {
    const png = head('img/bandeira.png', 8);
    for (const path of ['img/falso-html.png', 'img/falso-svg.png', 'img/falso-jpeg.png'])
      expect([path, head(path, 8)]).not.toEqual([path, png]);
    expect(head('img/falso-jpeg.png', 3)).toEqual([0xff, 0xd8, 0xff]);
    expect(head('img/documento.bmp', 2)).toEqual(ascii('BM'));
    expect(vault['.git/x.png']).toBeInstanceOf(Uint8Array);
    expect(vault['.simplemd/x.png']).toBeInstanceOf(Uint8Array);
  });

  test('SVG hostil traz script, onload, image externa e foreignObject', () => {
    const svg = new TextDecoder().decode(vault['img/hostil.svg'] as Uint8Array);
    for (const vector of ['<script>', 'onload=', 'href="https://', '<foreignObject', 'javascript:'])
      expect(svg).toContain(vector);
  });

  test('limites gerados na hora: raster 20 MiB + 1 e SVG 2 MiB + 1, com cabeçalho válido', () => {
    const raster = vault['img/grande.png'] as Uint8Array;
    const svg = vault['img/grande.svg'] as Uint8Array;
    expect(raster.length).toBe(FX_R7_LIMITS.raster + 1);
    expect(svg.length).toBe(FX_R7_LIMITS.svg + 1);
    expect(Array.from(raster.subarray(0, 8))).toEqual(head('img/bandeira.png', 8));
    const svgText = new TextDecoder().decode(svg);
    expect(svgText.startsWith('<svg')).toBe(true);
    expect(svgText.endsWith('</svg>\n')).toBe(true);
    expect(oversizeImage('png', 64)).toHaveLength(64);
  });

  test('imagens.md cita cada arquivo de recusa, os limites e as formas de caminho', () => {
    const md = text('imagens.md');
    for (const target of [
      'img/bandeira.png',
      '/img/foto.jpg',
      '<img/com espaços.png>',
      'img/com%20espa%C3%A7os.png',
      '../fora.png',
      '.git/x.png',
      'img/falso-html.png',
      'img/nao-existe.png',
      'img/hostil.svg',
      'img/grande.png',
      'img/grande.svg',
      'https://exemplo.org/x.png',
    ])
      expect(md).toContain(`(${target}`);
    expect(text('notas/sub/profunda.md')).toContain('(../../img/anim.gif)');
  });
});

describe('FX-R7: notas', () => {
  test('exatamente 200 tarefas no vault (todas as notas)', () => {
    const tasks = notes.flatMap((p) => text(p).match(/^\s*[-*+] \[.\] /gm) ?? []);
    expect(tasks).toHaveLength(FX_R7_TASKS);
    const all = notes.map(text).join('\n');
    for (const sign of [
      '📅',
      '⏳',
      '🛫',
      '➕',
      '✅',
      '❌',
      '🔺',
      '⏫',
      '🔼',
      '🔽',
      '⏬',
      '🔁',
      '📅 2026-13-45',
    ])
      expect(all).toContain(sign);
    for (const status of [' ', 'x', 'X', '-', '/']) expect(all).toContain(`- [${status}] `);
  });

  test('consultas.md: 10 tasks + 10 dataview de referência e 3 recusadas', () => {
    const md = text('consultas.md');
    expect(md.match(/^```tasks$/gm)).toHaveLength(11);
    expect(md.match(/^```dataview$/gm)).toHaveLength(11);
    expect(md.match(/^```dataviewjs$/gm)).toHaveLength(1);
  });

  test('backlinks de receitas/Bolo.md: exatamente as notas de FX_R7_BOLO_SOURCES', () => {
    const linking = notes.filter((path) => {
      const prose = text(path)
        .replace(/^```[\s\S]*?^```$/gm, '')
        .replace(/`[^`\n]+`/g, '');
      return path !== 'receitas/Bolo.md' && /(?<!!)\[\[(?:receitas\/)?bolo|Bolo\.md/i.test(prose);
    });
    expect(linking.sort()).toEqual([...FX_R7_BOLO_SOURCES]);
  });

  test('wikilinks ambíguos, com acento e inexistentes têm os alvos esperados no vault', () => {
    expect(vault['a/Nota.md']).toBeDefined();
    expect(vault['b/Nota.md']).toBeDefined();
    expect(vault['Pão.md']).toBeDefined();
    expect(vault['Pao.md']).toBeDefined();
    expect(vault['Nova ideia.md']).toBeUndefined();
    expect(text('wikilinks.md')).toContain('[[Bolo\\|na tabela]]');
  });

  test('notas byte a byte: espaços no fim e tabulações preservados (fora do Prettier)', () => {
    expect(text('lint.md')).toContain('Espaço no fim da linha.   \n');
    expect(text('lint.md')).toContain('Tabulação\taqui.');
    expect(text('listas.md')).toContain('\n\t+ Tabulação\n');
    expect(text('links.md')).toMatch(/\[longo\]\(https:\/\/exemplo\.org\/a{2029}\)/);
  });
});

describe('presets do harness (r7)', () => {
  test('FX-R7, FX-RICH-R7-10K e FX-2000-TASKS estão registrados', () => {
    expect(Object.keys(PRESETS['FX-R7']()).sort()).toEqual(Object.keys(vault).sort());
    const rich = PRESETS['FX-RICH-R7-10K']();
    expect((rich['rich-r7-10k.md'] as string).split('\n')).toHaveLength(10_000);
    expect(rich['img/imagem.webp']).toEqual(vault['img/imagem.webp']);
    expect(Object.keys(PRESETS['FX-2000-TASKS']())).toHaveLength(2000);
  });
});
