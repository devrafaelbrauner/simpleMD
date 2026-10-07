import type {
  Completion,
  CompletionContext,
  CompletionResult,
  CompletionSource,
} from '@codemirror/autocomplete';
import { syntaxTree } from '@codemirror/language';
import { EditorSelection, StateField, type EditorState } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import type { AutocompleteSettings } from './settings';

/** Texto sem acentos e sem caixa (filtro das notas `[[`; R-8.5). */
export function foldText(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase('pt-BR');
}

// ---- Palavras do documento (R-8.3) -------------------------------------------------------------

/** Linhas por bloco do índice de palavras: cada tecla só marca blocos sujos (O(mudanças)). */
const CHUNK_LINES = 200;
const MAX_WORD_OPTIONS = 50;
const WORD = /\p{L}{3,}/gu;
/** Nós cujo texto nunca vira sugestão de palavra (código e front matter; AC-8.2, AC-9.11). */
const NO_WORDS: Readonly<Record<string, true>> = {
  FencedCode: true,
  CodeBlock: true,
  InlineCode: true,
  FrontMatter: true,
};

interface WordIndex {
  /** Contagem de palavras por bloco de 200 linhas; `undefined` = bloco sujo (recontado sob demanda). */
  readonly chunks: (Map<string, number> | undefined)[];
}

/**
 * Índice de palavras por blocos: a transação só marca os blocos tocados (e os seguintes, quando o
 * número de linhas muda); a contagem acontece na consulta, nunca no quadro da tecla (NFR-21).
 */
export const wordIndexField = StateField.define<WordIndex>({
  create: (state) => ({
    chunks: new Array(Math.ceil(state.doc.lines / CHUNK_LINES)).fill(undefined),
  }),
  update(value, tr) {
    if (!tr.docChanged) return value;
    const count = Math.ceil(tr.state.doc.lines / CHUNK_LINES);
    const chunks = value.chunks.slice(0, count);
    while (chunks.length < count) chunks.push(undefined);
    let first = Number.POSITIVE_INFINITY;
    let last = -1;
    tr.changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
      first = Math.min(first, tr.state.doc.lineAt(fromB).number);
      last = Math.max(last, tr.state.doc.lineAt(toB).number);
    });
    const shifted = tr.state.doc.lines !== tr.startState.doc.lines;
    const from = Math.floor((first - 1) / CHUNK_LINES);
    const to = shifted ? count - 1 : Math.floor((last - 1) / CHUNK_LINES);
    for (let i = from; i <= to && i < count; i++) chunks[i] = undefined;
    return { chunks };
  },
});

function countChunk(state: EditorState, chunk: number): Map<string, number> {
  const doc = state.doc;
  const firstLine = chunk * CHUNK_LINES + 1;
  const lastLine = Math.min(doc.lines, firstLine + CHUNK_LINES - 1);
  const from = doc.line(firstLine).from;
  const to = doc.line(lastLine).to;
  const excluded: Array<[number, number]> = [];
  syntaxTree(state).iterate({
    from,
    to,
    enter(node) {
      if (!NO_WORDS[node.name]) return undefined;
      excluded.push([node.from, node.to]);
      return false;
    },
  });
  const counts = new Map<string, number>();
  const text = doc.sliceString(from, to);
  for (const match of text.matchAll(WORD)) {
    const at = from + (match.index ?? 0);
    if (excluded.some(([a, b]) => at >= a && at < b)) continue;
    counts.set(match[0], (counts.get(match[0]) ?? 0) + 1);
  }
  return counts;
}

/** Contagem total (recontando só os blocos sujos; o resultado não volta ao estado). */
export function documentWords(state: EditorState): Map<string, number> {
  const index = state.field(wordIndexField, false);
  const chunks =
    index?.chunks ?? new Array(Math.ceil(state.doc.lines / CHUNK_LINES)).fill(undefined);
  const total = new Map<string, number>();
  chunks.forEach((cached, i) => {
    const counts = cached ?? countChunk(state, i);
    chunks[i] = counts;
    for (const [word, n] of counts) total.set(word, (total.get(word) ?? 0) + n);
  });
  return total;
}

function wordsSource(settings: AutocompleteSettings): CompletionSource {
  return (context: CompletionContext): CompletionResult | null => {
    const typed = context.matchBefore(/\p{L}+$/u);
    if (!typed && !context.explicit) return null;
    const prefix = typed?.text ?? '';
    if (!context.explicit && prefix.length < settings.minChars) return null;
    const counts = documentWords(context.state);
    // A palavra sendo digitada não conta como sugestão de si mesma.
    const own = counts.get(prefix);
    if (own !== undefined) {
      if (own <= 1) counts.delete(prefix);
      else counts.set(prefix, own - 1);
    }
    const needle = foldText(prefix);
    const ranked = [...counts]
      .filter(([word]) => word !== prefix && foldText(word).includes(needle))
      .map(([word, n]) => ({ word, n, starts: foldText(word).startsWith(needle) }))
      .sort(
        (a, b) =>
          Number(b.starts) - Number(a.starts) || b.n - a.n || a.word.localeCompare(b.word, 'pt-BR'),
      )
      .slice(0, MAX_WORD_OPTIONS);
    if (ranked.length === 0) return null;
    return {
      from: typed?.from ?? context.pos,
      options: ranked.map(({ word }) => ({ label: word, type: 'text' })),
      filter: false,
    };
  };
}

// ---- Snippets (R-8.4) ----------------------------------------------------------------------------

interface Snippet {
  readonly label: string;
  readonly detail: string;
  /** Texto inserido e o trecho selecionado (o primeiro "placeholder"; sem navegação por Tab). */
  build(today: string): { text: string; select: [number, number] };
}

const caret = (text: string, marker: string) => {
  const at = text.indexOf(marker);
  return { text: text.replace(marker, ''), select: [at, at] as [number, number] };
};
const selecting = (text: string, word: string) => {
  const at = text.indexOf(word);
  return { text, select: [at, at + word.length] as [number, number] };
};

/** STR-91: rótulos (vinculantes) e detalhes. */
export const SNIPPETS: readonly Snippet[] = [
  {
    label: 'tabela',
    detail: 'Tabela 3×2',
    build: () =>
      selecting(
        '| Coluna 1 | Coluna 2 | Coluna 3 |\n| --- | --- | --- |\n|  |  |  |\n|  |  |  |\n',
        'Coluna 1',
      ),
  },
  { label: 'codigo', detail: 'Bloco de código', build: () => caret('```\n§\n```\n', '§') },
  { label: 'link', detail: 'Link', build: () => selecting('[texto](url)', 'texto') },
  { label: 'imagem', detail: 'Imagem', build: () => selecting('![alt](caminho)', 'alt') },
  { label: 'tarefa', detail: 'Item de tarefa', build: () => caret('- [ ] §', '§') },
  { label: 'citacao', detail: 'Citação', build: () => caret('> §', '§') },
  { label: 'formula', detail: 'Bloco de fórmula', build: () => caret('$$\n§\n$$\n', '§') },
  {
    label: 'mermaid',
    detail: 'Diagrama Mermaid',
    build: () => selecting('```mermaid\nflowchart TD\n  A --> B\n```\n', 'A --> B'),
  },
  {
    label: 'frontmatter',
    detail: 'Front matter YAML',
    build: () => caret('---\ntitle: §\n---\n', '§'),
  },
  { label: 'data', detail: 'Data de hoje (AAAA-MM-DD)', build: (today) => caret(`${today}§`, '§') },
];

function hasFrontMatter(state: EditorState): boolean {
  return syntaxTree(state).topNode.firstChild?.name === 'FrontMatter';
}

function snippetsSource(settings: AutocompleteSettings, today: () => string): CompletionSource {
  const prefix = settings.snippetPrefix;
  return (context) => {
    const line = context.state.doc.lineAt(context.pos);
    const before = line.text.slice(0, context.pos - line.from);
    const match = /\p{L}*$/u.exec(before);
    const word = match?.[0] ?? '';
    const at = before.length - word.length - 1;
    if (at < 0 || before[at] !== prefix) return null;
    if (at > 0 && !/\s/.test(before[at - 1] ?? '')) return null;
    const onFirstLine = line.number === 1 && !hasFrontMatter(context.state);
    const options: Completion[] = SNIPPETS.filter(
      (s) => s.label !== 'frontmatter' || (onFirstLine && at === 0),
    ).map((snippet) => ({
      label: snippet.label,
      detail: snippet.detail,
      type: 'text',
      apply: (view: EditorView, _completion: Completion, from: number, to: number) => {
        const { text, select } = snippet.build(today());
        const start = from - 1; // inclui o caractere de prefixo
        view.dispatch({
          changes: { from: start, to, insert: text },
          selection: EditorSelection.range(start + select[0], start + select[1]),
          userEvent: 'input.complete',
          scrollIntoView: true,
        });
      },
    }));
    return { from: line.from + at + 1, options, validFor: /^\p{L}*$/u };
  };
}

// ---- Notas `[[` (R-8.5) ---------------------------------------------------------------------------

export interface NoteRef {
  readonly path: string;
  readonly title: string;
}

interface PreparedNotes {
  readonly items: ReadonlyArray<{ note: NoteRef; key: string; title: string }>;
  readonly unique: ReadonlySet<string>;
}

const prepared = new WeakMap<readonly NoteRef[], PreparedNotes>();

function prepare(notes: readonly NoteRef[]): PreparedNotes {
  const cached = prepared.get(notes);
  if (cached) return cached;
  const seen = new Map<string, number>();
  const base = (path: string) => path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/i, '');
  for (const note of notes) {
    const key = base(note.path).toLocaleLowerCase('pt-BR');
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  const value: PreparedNotes = {
    items: notes.map((note) => ({
      note,
      key: `${foldText(note.title)}\n${foldText(note.path)}`,
      title: foldText(note.title),
    })),
    unique: new Set([...seen].filter(([, n]) => n === 1).map(([key]) => key)),
  };
  prepared.set(notes, value);
  return value;
}

/** Texto do link: `[[nome]]` se o nome do arquivo é único no vault, senão o caminho sem `.md`. */
export function noteLinkTarget(path: string, notes: readonly NoteRef[]): string {
  const name = path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/i, '');
  return prepare(notes).unique.has(name.toLocaleLowerCase('pt-BR'))
    ? name
    : path.replace(/\.md$/i, '');
}

function notesSource(getNotes: () => readonly NoteRef[]): CompletionSource {
  return (context) => {
    const typed = context.matchBefore(/\[\[[^\]\n]*$/);
    if (!typed) return null;
    const notes = getNotes();
    const query = foldText(typed.text.slice(2));
    const ranked = prepare(notes)
      .items.filter((item) => item.key.includes(query))
      .sort(
        (a, b) =>
          Number(b.title.startsWith(query)) - Number(a.title.startsWith(query)) ||
          a.note.title.localeCompare(b.note.title, 'pt-BR'),
      )
      .slice(0, MAX_WORD_OPTIONS);
    if (ranked.length === 0) return null;
    return {
      from: typed.from + 2,
      filter: false,
      options: ranked.map(({ note }) => ({
        label: note.title,
        detail: note.path,
        type: 'text',
        apply: (view: EditorView, _completion: Completion, from: number, to: number) => {
          const closing = view.state.doc.sliceString(to, to + 2) === ']]' ? 2 : 0;
          const insert = `${noteLinkTarget(note.path, getNotes())}]]`;
          view.dispatch({
            changes: { from, to: to + closing, insert },
            selection: { anchor: from + insert.length },
            userEvent: 'input.complete',
          });
        },
      })),
    };
  };
}

// ---- Montagem -------------------------------------------------------------------------------------

export interface AppCompletionDeps {
  /** Notas do vault (catálogo; antes do índice, os `.md` do explorador). */
  readonly notes: () => readonly NoteRef[];
  /** Data de hoje `AAAA-MM-DD` (relógio injetável; H20). */
  readonly today: () => string;
}

/** Fontes do app ligadas nas configurações (palavras, snippets, notas `[[`). */
export function appCompletionSources(
  settings: AutocompleteSettings,
  deps: AppCompletionDeps,
): CompletionSource[] {
  const sources: CompletionSource[] = [];
  if (settings.sources.words) sources.push(wordsSource(settings));
  if (settings.sources.snippets) sources.push(snippetsSource(settings, deps.today));
  if (settings.sources.notes) sources.push(notesSource(deps.notes));
  return sources;
}

/** `AAAA-MM-DD` local de um instante. */
export function isoDay(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
