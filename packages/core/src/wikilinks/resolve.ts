/**
 * Resolução determinística de wikilinks (R-I2.3, D-37; arch-backend r7 §1.7.8). Função pura e
 * ÚNICA: o editor, o serviço de links, o índice reverso (painel "Links") e a exportação delegam a
 * ela. Alvo normalizado (sem espaços nas pontas, sem `.md`, NFC), comparação sem caixa
 * (`toLocaleLowerCase('pt-BR')`), acentos significativos. Com `/` → caminho a partir da raiz;
 * sem `/` → nome do arquivo, e entre vários: mesma pasta da nota atual > menos pastas no caminho
 * (JEV D-R7-S2-01b) > ordem alfabética pt-BR.
 */

/** Notas do vault indexadas por nome e por caminho (sem caixa, NFC, sem `.md`). */
export interface NoteNameIndex {
  readonly paths: ReadonlySet<string>;
  readonly byName: ReadonlyMap<string, readonly string[]>;
  readonly byPath: ReadonlyMap<string, readonly string[]>;
}

export type WikilinkResolution =
  | {
      readonly kind: 'resolved';
      readonly path: string;
      /** Outras notas com o mesmo nome (até 3, na ordem da regra) e o total delas (W1 STR-148). */
      readonly others: readonly string[];
      readonly otherCount: number;
    }
  | {
      readonly kind: 'missing';
      /** Onde ⌘-clique criaria a nota (R-I2.5); a validação do nome é do `@simplemd/vault`. */
      readonly createPath: string;
      /**
       * O app validou o nome (a mesma função do clique; CR-S2-03) e o recusaria: o aviso STR-150
       * pronto. Ausente sem app (o núcleo não cria notas).
       */
      readonly refused?: string;
    };

/** Quantas "outras notas" a dica mostra (STR-148). */
export const WIKILINK_OTHERS_SHOWN = 3;

const MD_EXT = /\.md$/i;

const keyOf = (text: string) => text.normalize('NFC').toLocaleLowerCase('pt-BR');

const folderOf = (path: string) => {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? '' : path.slice(0, slash);
};

/** Alvo como caminho: sem espaços nas pontas, NFC, sem `/` inicial e sem `.md` final. */
export function normalizeWikiTarget(raw: string): string {
  return raw.trim().normalize('NFC').replace(/^\/+/, '').replace(MD_EXT, '').trim();
}

/** Índice de nomes do conjunto de notas: refeito só quando o conjunto de caminhos muda. */
export function createNoteNameIndex(paths: Iterable<string>): NoteNameIndex {
  const set = new Set<string>();
  const byName = new Map<string, string[]>();
  const byPath = new Map<string, string[]>();
  const add = (map: Map<string, string[]>, key: string, path: string) => {
    const list = map.get(key);
    if (list) list.push(path);
    else map.set(key, [path]);
  };
  for (const path of paths) {
    if (!MD_EXT.test(path) || set.has(path)) continue;
    set.add(path);
    const bare = path.replace(MD_EXT, '');
    add(byPath, keyOf(bare), path);
    add(byName, keyOf(bare.slice(bare.lastIndexOf('/') + 1)), path);
  }
  return { paths: set, byName, byPath };
}

/** Caminho da nota nova para um alvo inexistente (R-I2.5): sem `/` → pasta da nota atual. */
export function wikilinkCreatePath(target: string, fromPath: string | null): string {
  const name = normalizeWikiTarget(target);
  if (name === '') return '';
  if (target.includes('/')) return `${name}.md`;
  const folder = fromPath === null ? '' : folderOf(fromPath);
  return folder === '' ? `${name}.md` : `${folder}/${name}.md`;
}

/**
 * Nota de um link `.md` relativo já resolvido para caminho do vault (índice reverso): o caminho
 * exato se existe; senão, a mesma comparação dos wikilinks — sem caixa, NFC (CR-S2-04; no macOS e
 * no Windows o link abre a nota por esse caminho). Entre variantes só de caixa, a menor em bytes.
 */
export function resolveNotePath(path: string, notes: NoteNameIndex): string | null {
  if (notes.paths.has(path)) return path;
  const found = notes.byPath.get(keyOf(path.replace(MD_EXT, '')));
  if (!found || found.length === 0) return null;
  return found.reduce((a, b) => (b < a ? b : a));
}

/** Ordem da regra D-37 a partir da nota `fromPath`. */
function byRule(fromPath: string | null): (a: string, b: string) => number {
  const here = fromPath === null ? null : folderOf(fromPath);
  return (a, b) => {
    const sameA = here !== null && folderOf(a) === here ? 0 : 1;
    const sameB = here !== null && folderOf(b) === here ? 0 : 1;
    if (sameA !== sameB) return sameA - sameB;
    const depth = a.split('/').length - b.split('/').length;
    if (depth !== 0) return depth;
    // Empate canônico (NFC × NFD) → ordem de bytes; caminhos repetidos não chegam aqui (conjunto).
    return a.localeCompare(b, 'pt-BR') || (a < b ? -1 : 1);
  };
}

/**
 * Resolve `target` (alvo cru, sem apelido nem `#título`) a partir da nota `fromPath`. Alvo vazio
 * (`[[#Título]]`) = a própria nota.
 */
export function resolveWikilink(
  target: string,
  fromPath: string | null,
  notes: NoteNameIndex,
): WikilinkResolution {
  const name = normalizeWikiTarget(target);
  if (name === '') {
    return fromPath === null
      ? { kind: 'missing', createPath: '' }
      : { kind: 'resolved', path: fromPath, others: [], otherCount: 0 };
  }
  const key = keyOf(name);
  const found = (name.includes('/') ? notes.byPath : notes.byName).get(key);
  if (!found || found.length === 0)
    return { kind: 'missing', createPath: wikilinkCreatePath(target, fromPath) };
  const ordered = found.length === 1 ? found : [...found].sort(byRule(fromPath));
  const [path, ...rest] = ordered as [string, ...string[]];
  return {
    kind: 'resolved',
    path,
    others: rest.slice(0, WIKILINK_OTHERS_SHOWN),
    otherCount: rest.length,
  };
}
