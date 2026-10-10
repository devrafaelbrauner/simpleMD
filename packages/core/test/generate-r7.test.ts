import { ensureSyntaxTree } from '@codemirror/language';
import { describe, expect, it } from 'vitest';
import { createMarkdownState } from '../src';
import {
  generateRichR7Markdown,
  generateTasksVault,
  RICH_R7_COUNTS,
  TASKS_VAULT_COUNTS,
  tasksVaultNotePath,
} from '../src/testing';

/** Contagem de nós Lezer por nome (GFM do editor), com a árvore completa. */
function countNodes(text: string): Map<string, number> {
  const state = createMarkdownState(text, { livePreview: false });
  const tree = ensureSyntaxTree(state, state.doc.length, 30_000);
  if (!tree) throw new Error('árvore incompleta');
  const counts = new Map<string, number>();
  tree.iterate({ enter: (node) => void counts.set(node.name, (counts.get(node.name) ?? 0) + 1) });
  return counts;
}

describe('generateRichR7Markdown (rich-r7-10k.md, product r7 §6)', () => {
  const text = generateRichR7Markdown();

  it('10.000 linhas, determinístico pela semente', () => {
    expect(text).toBe(generateRichR7Markdown());
    expect(text).not.toBe(generateRichR7Markdown(8));
    expect(text.split('\n')).toHaveLength(RICH_R7_COUNTS.lines);
  });

  it('as contagens do §6 batem com a árvore de sintaxe do editor', () => {
    const nodes = countNodes(text);
    // Sem a extensão de wikilinks (S2), cada `[[x]]` ainda é um `Link` do Lezer: 200 em linha +
    // 100 de referência + 300 wikilinks. `URL`: 200 em linha + 100 autolinks + 100 GFM + 50
    // imagens + 10 definições de referência.
    expect(nodes.get('Link')).toBe(200 + 100 + RICH_R7_COUNTS.wikilinks);
    expect(nodes.get('Autolink')).toBe(100);
    expect(nodes.get('URL')).toBe(200 + 100 + 100 + RICH_R7_COUNTS.images + 10);
    expect(nodes.get('Task')).toBe(RICH_R7_COUNTS.tasks);
    expect(nodes.get('Strikethrough')).toBe(RICH_R7_COUNTS.strikethroughs);
    expect(nodes.get('InlineCode')).toBe(RICH_R7_COUNTS.inlineCodes);
    expect(nodes.get('Image')).toBe(RICH_R7_COUNTS.images);
    expect(nodes.get('HTMLBlock')).toBe(RICH_R7_COUNTS.htmlBlocks);
    expect(nodes.get('Table')).toBe(RICH_R7_COUNTS.tables);
    expect(nodes.get('LinkReference')).toBe(10);
    expect(text.match(/^```(?:tasks|dataview)$/gm)).toHaveLength(RICH_R7_COUNTS.queries);
    expect(text.match(/\[\[[^\]]+\]\]/g)).toHaveLength(RICH_R7_COUNTS.wikilinks);
    expect(text.match(/^(?:> )+\S/gm)).toHaveLength(RICH_R7_COUNTS.quotes);
    expect(
      text.match(
        /\]\(https:\/\/[^)]+\)|<https:[^>]+>| https:\/\/exemplo\.org\/gfm\/\d+|\]\[ref-\d\]/g,
      ),
    ).toHaveLength(RICH_R7_COUNTS.links);
  });

  it('as imagens apontam para os 5 tipos do FX-R7', () => {
    const targets = new Set(
      text.match(/!\[[^\]]*\]\(([^)]+)\)/g)?.map((m) => m.slice(m.indexOf('(') + 1, -1)),
    );
    expect([...targets].sort()).toEqual([
      'img/anim.gif',
      'img/bandeira.png',
      'img/desenho.svg',
      'img/foto.jpg',
      'img/imagem.webp',
    ]);
  });
});

describe('generateTasksVault (FX-2000-TASKS, product r7 §6, arch-backend C-7)', () => {
  const vault = generateTasksVault();
  const notes = Object.entries(vault);
  const TASK = /^- \[[ x]\] (.*)$/gm;
  const SIGN = / (?:📅|⏳|🛫|➕|✅|❌|🔺|⏫|🔼|🔽|⏬|🔁|#)/u;
  const names = new Set(Object.keys(vault).map((p) => p.slice(p.indexOf('/') + 1, -'.md'.length)));

  it('2.000 notas em 20 pastas, determinístico pela semente', () => {
    expect(notes).toHaveLength(TASKS_VAULT_COUNTS.notes);
    expect(new Set(Object.keys(vault).map((p) => p.split('/')[0])).size).toBe(20);
    expect(Object.keys(vault)[0]).toBe(tasksVaultNotePath(0));
    expect(tasksVaultNotePath(1999)).toBe('projetos-20/tarefas-2000.md');
    expect(generateTasksVault({ notes: 50 })).toEqual(generateTasksVault({ notes: 50 }));
    expect(generateTasksVault({ notes: 50, seed: 1 })).not.toEqual(
      generateTasksVault({ notes: 50 }),
    );
  });

  it('cada nota: 5 propriedades, 10 links para notas existentes e 20 tarefas', () => {
    for (const [path, text] of notes) {
      const front = /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1] ?? '';
      expect([path, front.split('\n').length]).toEqual([
        path,
        TASKS_VAULT_COUNTS.propertiesPerNote,
      ]);
      const wikilinks = [...text.matchAll(/\[\[([^\]]+)\]\]/g)].map((m) => m[1]);
      const mdLinks = [...text.matchAll(/\]\(([^)]+\.md)\)/g)].map((m) => m[1]!);
      expect(wikilinks.length + mdLinks.length).toBe(TASKS_VAULT_COUNTS.linksPerNote);
      for (const name of wikilinks) expect(names.has(name!)).toBe(true);
      const folder = path.slice(0, path.indexOf('/'));
      for (const link of mdLinks)
        expect(vault[link.startsWith('../') ? link.slice(3) : `${folder}/${link}`]).toBeDefined();
      expect(text.match(TASK)).toHaveLength(TASKS_VAULT_COUNTS.tasksPerNote);
    }
  });

  it('descrições de 30–70 caracteres, média ≈ 50 (C-7)', () => {
    const lengths: number[] = [];
    for (const [, text] of notes)
      for (const [, body] of text.matchAll(TASK)) {
        const cut = body!.search(SIGN);
        const description = cut < 0 ? body! : body!.slice(0, cut);
        lengths.push(description.length);
      }
    expect(lengths).toHaveLength(TASKS_VAULT_COUNTS.notes * TASKS_VAULT_COUNTS.tasksPerNote);
    expect(Math.min(...lengths)).toBeGreaterThanOrEqual(TASKS_VAULT_COUNTS.descriptionMin);
    expect(Math.max(...lengths)).toBeLessThanOrEqual(TASKS_VAULT_COUNTS.descriptionMax);
    const mean = lengths.reduce((a, b) => a + b, 0) / lengths.length;
    expect(mean).toBeGreaterThan(48);
    expect(mean).toBeLessThan(52);
  });
});
