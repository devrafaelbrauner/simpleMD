import {
  createNoteNameIndex,
  extractLinks,
  extractNoteMeta,
  parseFrontMatterYaml,
  resolveWikilink,
} from '@simplemd/core';
import type {
  IndexedNote,
  IndexedTask,
  PropertyValue,
  TasksCatalog,
  TasksCatalogSnapshot,
} from '@simplemd/plugin-api/internal/tasks-catalog';
// O MESMO parser de linha do indexador (S9a), pelo arquivo do núcleo.
import { parseTaskLine } from '../../core/src/tasks/line';

const files = import.meta.glob<string>('../../../apps/desktop/harness/fixtures/r7/vault/**/*.md', {
  eager: true,
  query: '?raw',
  import: 'default',
});

const PREFIX = '../../../apps/desktop/harness/fixtures/r7/vault/';

/** Notas do vault `FX-R7` (texto como no disco). */
export function fxR7Files(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(files).map(([file, text]) => [file.slice(PREFIX.length), text]),
  );
}

function frontMatter(text: string): Record<string, PropertyValue> {
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(text);
  const out: Record<string, PropertyValue> = Object.create(null) as Record<string, PropertyValue>;
  if (!match) return out;
  const parsed = parseFrontMatterYaml(match[1]!);
  if (!parsed.ok) return out;
  for (const { key, value } of parsed.properties) {
    out[key] =
      value === null || ['string', 'number', 'boolean'].includes(typeof value)
        ? (value as PropertyValue)
        : Array.isArray(value)
          ? (value as PropertyValue)
          : JSON.stringify(value);
  }
  return out;
}

/**
 * Nota do índice v3 montada como o extrator do backend (S9a) a monta: metadados do núcleo,
 * propriedades do front matter, links do extrator de S2 e tarefas pelo parser de linha do núcleo.
 */
export function indexNote(path: string, raw: string, mtime = 0): IndexedNote {
  const text = raw.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const meta = extractNoteMeta(raw, path);
  const tasks: IndexedTask[] = [];
  text.split('\n').forEach((line, i) => {
    const task = parseTaskLine(line, i);
    if (task) tasks.push(task);
  });
  const inlineTags = [...new Set(tasks.flatMap((task) => task.tags))];
  return {
    path,
    title: meta.title,
    tags: meta.tags,
    inlineTags,
    date: meta.date,
    mtime,
    size: new TextEncoder().encode(raw).length,
    fmError: meta.fmError,
    properties: frontMatter(text),
    links: extractLinks(text, path).links,
    tasks,
    truncated: [],
  };
}

/** Catálogo de teste sobre notas prontas (as escritas não são usadas pelo avaliador). */
export function fakeCatalog(
  notes: readonly IndexedNote[],
  status: TasksCatalogSnapshot['status'] = 'ready',
): TasksCatalog & {
  publish(next: readonly IndexedNote[], nextStatus?: TasksCatalogSnapshot['status']): void;
} {
  let snapshot: TasksCatalogSnapshot = {
    version: 1,
    status,
    notes: [...notes].sort((a, b) => (a.path < b.path ? -1 : 1)),
  };
  const listeners = new Set<() => void>();
  const names = () => createNoteNameIndex(snapshot.notes.map((note) => note.path));
  const resolve = (fromPath: string, target: string) => {
    const result = resolveWikilink(target, fromPath, names());
    return result.kind === 'resolved' ? result.path : null;
  };
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    resolveWikilink: resolve,
    backlinks(path) {
      return snapshot.notes
        .filter(
          (note) =>
            note.path !== path &&
            note.links.some((link) =>
              link.kind === 'wikilink'
                ? resolve(note.path, link.target) === path
                : link.target === path,
            ),
        )
        .map((note) => note.path);
    },
    parseTaskLine: (raw) => parseTaskLine(raw),
    editTask: () => Promise.resolve({ ok: false, reason: 'unchanged' }),
    toggleTask: () => Promise.resolve({ ok: true, target: 'disk' }),
    openSource: () => {},
    openNote: () => {},
    publish(next, nextStatus = 'ready') {
      snapshot = {
        version: snapshot.version + 1,
        status: nextStatus,
        notes: [...next].sort((a, b) => (a.path < b.path ? -1 : 1)),
      };
      for (const listener of listeners) listener();
    },
  };
}

/** O vault `FX-R7` indexado. */
export function fxR7Notes(): IndexedNote[] {
  return Object.entries(fxR7Files()).map(([path, text]) => indexNote(path, text));
}

/** Blocos de consulta de `consultas.md` na ordem do arquivo. */
export function fxR7Queries(): { info: string; code: string }[] {
  const text = fxR7Files()['consultas.md']!;
  return [...text.matchAll(/^```(\S+)\n([\s\S]*?)\n```$/gm)].map((m) => ({
    info: m[1]!,
    code: m[2]!,
  }));
}
