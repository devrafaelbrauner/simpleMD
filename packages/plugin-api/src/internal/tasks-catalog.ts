/**
 * Interface privada do catálogo para o plugin interno `simplemd.tasks` (r7 arch-backend §1.8,
 * arch-frontend §3.3; R-I9.1, R-I9.7; AC-I9.1, AC-I9.7, NFR-49). Só tipos, fora da API pública de
 * plugins (`src/types.ts` congelado, `PluginAPI` com 8 membros): não é reexportada por `src/types.ts`
 * nem por `./runtime`, e a regra de lint libera este subpath só para
 * `packages/plugins-internal/src/tasks/**`.
 *
 * O objeto existe só na closure do registro `apps/desktop/src/plugins/internal/tasks.ts` (único
 * arquivo do app que importa a implementação `apps/desktop/src/catalog/tasks-catalog.ts`): nenhum
 * `window.*`, nenhum módulo hospedeiro, nenhum argumento novo no `activate`.
 *
 * As formas abaixo são as do índice em memória do `@simplemd/vault` (`IndexEntry` v3, campos
 * legíveis); um teste de tipos prova que `IndexEntry` é atribuível a {@link IndexedNote}.
 */

/** Valor de propriedade do front matter (objeto aninhado chega como texto JSON). */
export type PropertyValue =
  string | number | boolean | null | readonly (string | number | boolean | null)[];

/**
 * Link de saída de uma nota. Posição 0-based em unidades UTF-16 do texto normalizado (sem BOM, só
 * `\n`). `wikilink`: alvo cru (resolvido na leitura por {@link TasksCatalog.resolveWikilink});
 * `inline`/`reference`: caminho do vault já resolvido.
 */
export interface IndexedLink {
  readonly line: number;
  readonly column: number;
  readonly length: number;
  readonly kind: 'wikilink' | 'inline' | 'reference';
  readonly target: string;
}

/** Campos de data de uma tarefa (sinais 📅 ⏳ 🛫 ➕ ✅ ❌; R-I9.2). */
export type TaskDateField = 'due' | 'scheduled' | 'start' | 'created' | 'done' | 'cancelled';

/** Prioridade: 0 ⏬ mínima, 1 🔽 baixa, 2 sem prioridade, 3 🔼 média, 4 ⏫ alta, 5 🔺 máxima. */
export type TaskPriority = 0 | 1 | 2 | 3 | 4 | 5;

/** Uma tarefa (linha de lista com caixa) no formato de emojis do Obsidian Tasks (R-I9.2). */
export interface IndexedTask {
  /** 0-based no texto normalizado; `-1` quando veio de {@link TasksCatalog.parseTaskLine}. */
  readonly line: number;
  /** 1 caractere: `' '` | `'x'` | `'X'` | `'-'` | `'/'` | outro (= a fazer). */
  readonly status: string;
  /** Descrição sem os sinais (≤ 1.000 caracteres), com as `#tags`. */
  readonly text: string;
  readonly due?: string;
  readonly scheduled?: string;
  readonly start?: string;
  readonly created?: string;
  readonly done?: string;
  readonly cancelled?: string;
  readonly priority: TaskPriority;
  /** Texto depois de 🔁 (≤ 200 caracteres). */
  readonly recurrence?: string;
  /** `#tags` da descrição, na ordem do texto, sem repetição. */
  readonly tags: readonly string[];
  /** Campos cuja data não é `AAAA-MM-DD` válida (ignorados; "data inválida" nos resultados). */
  readonly invalid: readonly TaskDateField[];
}

/** Teto atingido na extração de uma nota (os excedentes não entram no índice). */
export type TruncatedField = 'links' | 'tasks' | 'props' | 'itags';

/** Uma nota do índice v3. */
export interface IndexedNote {
  readonly path: string;
  readonly title: string;
  /** Tags do front matter. */
  readonly tags: readonly string[];
  /** Tags do corpo (`#ideia`, com `#`), ≤ 100. `file.tags` = união com {@link tags}. */
  readonly inlineTags: readonly string[];
  readonly date: string | null;
  readonly mtime: number;
  readonly size: number;
  readonly fmError: boolean;
  /** Front matter (≤ 100 chaves), objeto sem protótipo. */
  readonly properties: Readonly<Record<string, PropertyValue>>;
  readonly links: readonly IndexedLink[];
  readonly tasks: readonly IndexedTask[];
  readonly truncated: readonly TruncatedField[];
}

export interface TasksCatalogSnapshot {
  /** Muda a cada publicação. */
  readonly version: number;
  readonly status: 'loading' | 'building' | 'ready';
  /** Ordenadas por caminho. */
  readonly notes: readonly IndexedNote[];
}

/** Uma tarefa de uma nota, como estava no índice quando o resultado foi montado. */
export interface TaskRef {
  readonly path: string;
  readonly task: IndexedTask;
}

/**
 * `changed`: a linha atual não é mais a esperada (0 gravações; o catálogo reindexa a nota).
 * `conflict`: a nota está em conflito (0 gravações). `missing`: a nota não existe mais.
 * `unchanged`: o `transform` não tinha nada a fazer. `io`: outra falha de leitura/gravação.
 */
export type TaskEditResult =
  | { readonly ok: true; readonly target: 'editor' | 'disk' }
  | {
      readonly ok: false;
      readonly reason: 'changed' | 'conflict' | 'missing' | 'unchanged' | 'io';
    };

/**
 * Resultado de {@link TasksCatalog.toggleTask}: o da escrita e, se a regra de recorrência da tarefa
 * está fora do subconjunto de R-I9.7, o texto dela (a tarefa só alternou; o app avisou).
 */
export type TaskToggleResult = TaskEditResult & { readonly unsupportedRule?: string };

export interface TasksCatalog {
  /** Imutável; `version` muda a cada publicação. */
  getSnapshot(): TasksCatalogSnapshot;
  /** Avisa a cada publicação do índice. Devolve o descarte. */
  subscribe(listener: () => void): () => void;
  /** Caminho da nota alvo de `[[target]]` escrito em `fromPath` (regra R-I2.3) ou `null`. */
  resolveWikilink(fromPath: string, target: string): string | null;
  /** Notas que apontam para `path` (wikilink + link `.md`), sem a própria, ordenadas por caminho. */
  backlinks(path: string): readonly string[];
  /** O MESMO parser de linha do indexador (`packages/core/src/tasks/line.ts`); `line` = -1. */
  parseTaskLine(rawLine: string): IndexedTask | null;
  /**
   * No máximo uma gravação, só em `ref.path`, sempre com base de conteúdo (R-I9.7). `transform` é
   * puro: recebe a linha crua ATUAL e devolve as linhas que a substituem (recorrência = 2) ou `null`.
   * Nota aberta numa aba → uma transação no editor dela (desfazível; autosave), 0 gravações diretas.
   */
  editTask(
    ref: TaskRef,
    transform: (rawLine: string) => readonly string[] | null,
  ): Promise<TaskEditResult>;
  /**
   * Alterna a tarefa com a semântica de conclusão de R-I9.7 (✅ com `recordDoneDate`, recorrência) pelo
   * caminho de {@link editTask}. Os avisos ("A tarefa mudou no arquivo; …", regra não suportada) são
   * mostrados pelo app.
   */
  toggleTask(
    ref: TaskRef,
    options: { readonly recordDoneDate: boolean },
  ): Promise<TaskToggleResult>;
  /** Abre a nota da tarefa com o cursor na linha dela (R-I9.6; ⌘/Ctrl-clique ou Enter). */
  openSource(ref: TaskRef): void;
  /** Abre uma nota do índice (resultado de LIST/TABLE). */
  openNote(path: string): void;
}
