import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { Button } from '../components/ui/button';
import { Icon } from '../lib/icons';
import { foldText } from '../sidepanel/catalog-model';

/** Camada do dicionário do usuário (r32b; D-P26-03): deste computador ou desta pasta. */
export type DictionaryEditorLayer = 'global' | 'folder';

/**
 * Uma lista da camada em "Listas importadas" (r33): o nome do arquivo (`termos-medicos.txt`) e as
 * palavras dela, sem repetidas (`null` = o arquivo não pôde ser lido; o aviso da camada diz por
 * quê). O `pessoal.txt` não entra: ele não se renomeia nem se remove.
 */
export interface DictionaryEditorFile {
  readonly name: string;
  readonly words: number | null;
}

/** Uma camada como o serviço do app a mostra (dados simples: o `packages/ui` não conhece o app). */
export interface DictionaryEditorLayerView {
  /**
   * `idle`/`loading` = lendo; `ready`; `error` = a última leitura falhou (os termos são os da
   * anterior); `none` = camada da pasta sem pasta aberta.
   */
  readonly status: 'idle' | 'loading' | 'ready' | 'error' | 'none';
  /** Na ordem dos arquivos (`pessoal.txt` primeiro), sem duplicatas. */
  readonly terms: readonly string[];
  /** Avisos da camada (teto, arquivo deixado de fora, leitura que falhou): pt-BR, sem caminho. */
  readonly warnings: readonly { readonly id: string; readonly text: string }[];
  /** As listas da camada fora o `pessoal.txt` (r33), na ordem dos arquivos. */
  readonly files: readonly DictionaryEditorFile[];
}

export interface DictionaryEditorSnapshot {
  readonly global: DictionaryEditorLayerView;
  readonly folder: DictionaryEditorLayerView;
}

/** `absent`: a palavra já não estava em nenhum `.txt` lido da camada (saiu por fora). */
export type DictionaryEditorRemoveResult =
  | { readonly status: 'removed' | 'absent' | 'invalid' | 'no-folder' }
  | { readonly status: 'failed'; readonly message: string };

/**
 * Importação (r33): `imported` com o nome do arquivo criado e o resumo pronto para a região de
 * status ("“termos-medicos” importado: 50.000 palavras (lido como UTF-8)."); `cancelled` = o diálogo
 * foi fechado e nada mudou; `no-folder` = camada da pasta sem pasta aberta.
 */
export type DictionaryEditorImportResult =
  | { readonly status: 'imported'; readonly name: string; readonly summary: string }
  | { readonly status: 'cancelled' | 'no-folder' }
  | { readonly status: 'failed'; readonly message: string };

/** Renomear (`renamed`, com o nome novo do arquivo) ou remover (`removed`) uma lista (r33). */
export type DictionaryEditorListResult =
  | { readonly status: 'renamed'; readonly name: string }
  | { readonly status: 'removed' | 'no-folder' }
  | { readonly status: 'failed'; readonly message: string };

/**
 * O serviço de dicionário do app visto pela lista (r32b, `AppController.dictionary`): a primeira
 * assinatura começa a carga, o snapshot é imutável (`useSyncExternalStore`) e `remove` tira a
 * palavra de todos os `.txt` lidos da camada (D-R32-6). r33: `import` abre o diálogo nativo (pelo
 * Rust) e grava a lista escolhida na camada; `rename` (com o nome digitado, sem `.txt`) e
 * `removeList` levam o par do Hunspell e recusam o `pessoal.txt`. Nada disso rejeita, e a camada é
 * relida antes de a promessa resolver.
 */
export interface DictionaryEditorSource {
  subscribe(listener: () => void): () => void;
  getSnapshot(): DictionaryEditorSnapshot;
  remove(word: string, layer: DictionaryEditorLayer): Promise<DictionaryEditorRemoveResult>;
  import(layer: DictionaryEditorLayer): Promise<DictionaryEditorImportResult>;
  rename(
    layer: DictionaryEditorLayer,
    name: string,
    to: string,
  ): Promise<DictionaryEditorListResult>;
  removeList(layer: DictionaryEditorLayer, name: string): Promise<DictionaryEditorListResult>;
}

export interface DictionaryEditorProps {
  source: DictionaryEditorSource;
  /** Id do rótulo visível do grupo ("Dicionário"). */
  labelledBy: string;
  /** Id da ajuda da opção, quando há. */
  describedBy?: string;
}

/** Palavras mostradas de uma vez; a busca acha as outras. */
export const DICTIONARY_LIST_MAX = 100;
/** A contagem da busca é anunciada uma vez, depois da última tecla (como no catálogo, D-R2-6). */
const ANNOUNCE_DELAY_MS = 500;

const LAYERS: readonly { readonly value: DictionaryEditorLayer; readonly label: string }[] = [
  { value: 'global', label: 'Este computador' },
  { value: 'folder', label: 'Esta pasta' },
];

/** "do dicionário <camada>" (o mesmo nome do anúncio de "Adicionar ao dicionário", r32b). */
const WHERE: Readonly<Record<DictionaryEditorLayer, string>> = {
  global: 'deste computador',
  folder: 'desta pasta',
};

/** "12 palavras." / "3 de 2.345 palavras." e, acima do teto, o que fazer para ver as outras. */
function countText(matches: number, total: number, filtering: boolean): string {
  const all = `${total.toLocaleString('pt-BR')} ${total === 1 ? 'palavra' : 'palavras'}.`;
  const count = filtering ? `${matches.toLocaleString('pt-BR')} de ${all}` : all;
  if (matches <= DICTIONARY_LIST_MAX) return count;
  return `${count} Mostrando as ${DICTIONARY_LIST_MAX} primeiras; ${filtering ? 'refine a busca' : 'busque para achar as outras'}.`;
}

/** As primeiras palavras (até o teto) cujo texto sem acento nem caixa contém a busca. */
function search(
  terms: readonly string[],
  keys: readonly string[] | null,
  needle: string,
): { shown: readonly string[]; matches: number } {
  if (keys === null) return { shown: terms.slice(0, DICTIONARY_LIST_MAX), matches: terms.length };
  const shown: string[] = [];
  let matches = 0;
  for (let i = 0; i < keys.length; i++) {
    if (!keys[i]?.includes(needle)) continue;
    matches++;
    const term = terms[i];
    if (term !== undefined && shown.length < DICTIONARY_LIST_MAX) shown.push(term);
  }
  return { shown, matches };
}

function failure(
  result: DictionaryEditorRemoveResult | DictionaryEditorImportResult | DictionaryEditorListResult,
): string {
  if (result.status === 'failed') return result.message;
  if (result.status === 'no-folder') return 'nenhuma pasta aberta';
  return 'a palavra está fora do formato do dicionário';
}

/** O nome de uma lista na tela: o do arquivo sem o `.txt` em qualquer caixa (como o resumo). */
function listLabel(name: string): string {
  return name.replace(/\.txt$/i, '');
}

/** "1 palavra", "50.000 palavras"; `null` = o arquivo não pôde ser lido. */
function wordCount(words: number | null): string {
  if (words === null) return 'não pôde ser lida';
  return `${words.toLocaleString('pt-BR')} ${words === 1 ? 'palavra' : 'palavras'}`;
}

/** O 2º passo de remover uma lista: "Remover “termos-medicos” e suas 50.000 palavras?". */
function removeQuestion(label: string, words: number | null): string {
  if (words === null || words === 0) return `Remover “${label}”?`;
  if (words === 1) return `Remover “${label}” e sua única palavra?`;
  return `Remover “${label}” e suas ${words.toLocaleString('pt-BR')} palavras?`;
}

/** `aria-describedby` com os ids presentes (ou nenhum). */
function idList(...ids: ReadonlyArray<string | false>): string | undefined {
  const present = ids.filter((id): id is string => id !== false);
  return present.length > 0 ? present.join(' ') : undefined;
}

/** A lista em edição em "Listas importadas": o campo de renomear ou o 2º passo de remover. */
interface ListRow {
  readonly kind: 'rename' | 'confirm';
  readonly name: string;
}

/**
 * Para onde vai o foco quando "Listas importadas" mudar: ao controle `control` da lista `name`
 * (`field` = o campo de renomear) ou, se ela saiu (`removed` espera a saída), ao "Remover" da lista
 * que ocupou o lugar dela — ao da anterior, na última; a "Importar lista de termos…", sem nenhuma.
 */
interface ListFocus {
  readonly layer: DictionaryEditorLayer;
  readonly name: string;
  readonly control: 'field' | 'rename' | 'remove' | 'confirm';
  readonly index: number;
  readonly removed: boolean;
}

/** Erro da última operação de lista e o controle que ele descreve (`aria-describedby`). */
interface ListError {
  readonly control: 'import' | 'field' | 'remove';
  readonly name: string | null;
  readonly text: string;
}

/**
 * Lista do dicionário do usuário (r32c; design-r32 §1; opção `dictionary` do LanguageTool em
 * Configurações → Plugins): escolher a camada, buscar (sem acento nem caixa) e ver até 100 palavras,
 * cada uma com "Remover “<palavra>”". Remover tira a palavra de todos os `.txt` lidos da camada
 * (D-R32-6) e, se o foco segue na lista, leva-o à palavra seguinte (à anterior na última; à busca
 * quando a lista esvazia). Funciona com o plugin desligado: lê e grava pelo serviço do app. As
 * palavras e os avisos vêm de arquivos da pasta (entrada não confiável) e só entram como texto.
 *
 * r33 (design-r33 §1): "Listas importadas" da camada, fora o `pessoal.txt`, cada uma com "N
 * palavras", "Renomear “x”" (campo rotulado; Enter renomeia, Esc desfaz e o foco volta ao botão) e
 * "Remover “x”" em dois passos ("…e suas N palavras?" → "Confirmar remoção"; o foco vai à lista
 * seguinte). "Importar lista de termos…" grava na camada escolhida ("Vai para: …"); sem pasta, o
 * botão fica desabilitado com o motivo. O resumo vai a uma região de status; o erro, a um alerta.
 */
export function DictionaryEditor({ source, labelledBy, describedBy }: DictionaryEditorProps) {
  const base = useId();
  const searchId = `${base}-search`;
  const errorId = `${base}-error`;
  const countId = `${base}-count`;
  const listsTitleId = `${base}-lists`;
  const listErrorId = `${base}-list-error`;
  const destinationId = `${base}-destination`;
  const reasonId = `${base}-reason`;
  const fieldId = `${base}-field`;
  const fieldHintId = `${base}-field-hint`;
  const questionId = `${base}-question`;
  const subscribe = useCallback((listener: () => void) => source.subscribe(listener), [source]);
  const getSnapshot = useCallback(() => source.getSnapshot(), [source]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot);
  const [layer, setLayer] = useState<DictionaryEditorLayer>('global');
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ readonly word: string; readonly text: string } | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const groupRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  /** Uma remoção por vez (o clique repetido antes do novo render não pede outra). */
  const removing = useRef(false);
  /** Remoção pedida: quando a palavra sai da lista, o foco vai ao item que ocupou o lugar dela. */
  const pending = useRef<{ layer: DictionaryEditorLayer; word: string; index: number } | null>(
    null,
  );
  const [row, setRow] = useState<ListRow | null>(null);
  /** O que está no campo de renomear. */
  const [draft, setDraft] = useState('');
  const [listBusy, setListBusy] = useState(false);
  /** Resumo da última operação de lista (região de status visível). */
  const [listStatus, setListStatus] = useState('');
  const [listError, setListError] = useState<ListError | null>(null);
  const listsRef = useRef<HTMLDivElement>(null);
  const importRef = useRef<HTMLButtonElement>(null);
  const rowRef = useRef<HTMLLIElement>(null);
  /** Uma operação de lista por vez: importar, renomear ou remover. */
  const working = useRef(false);
  const listFocus = useRef<ListFocus | null>(null);

  const view = snapshot[layer];
  const needle = foldText(query.trim());
  const filtering = needle !== '';
  // As chaves sem acento só são calculadas ao buscar (uma vez por leitura da camada).
  const keys = useMemo(
    () => (filtering ? view.terms.map(foldText) : null),
    [view.terms, filtering],
  );
  const { shown, matches } = useMemo(
    () => search(view.terms, keys, needle),
    [view.terms, keys, needle],
  );
  const loading = view.status === 'idle' || view.status === 'loading';
  const where = WHERE[layer];
  const count = countText(matches, view.terms.length, filtering);
  const files = view.files;
  // A lista em edição só vale enquanto está na camada (ela pode sair por fora).
  const editing = row !== null && files.some((file) => file.name === row.name) ? row : null;
  const noFolder = view.status === 'none';
  const destination = LAYERS.find((option) => option.value === layer)?.label;

  // A contagem é anunciada só quando a busca muda (uma remoção já tem o próprio anúncio).
  const announcedQuery = useRef(query);
  useEffect(() => {
    if (query === announcedQuery.current) return;
    const timer = setTimeout(() => {
      announcedQuery.current = query;
      setAnnouncement(count);
    }, ANNOUNCE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [query, count]);

  // No mesmo commit em que a palavra removida some (o botão focado sai do DOM), o foco vai ao
  // próximo botão; sem botões, à busca ou à camada escolhida (sem pasta, a busca também sai). Só
  // se o foco caiu no `body` ou segue na lista: quem já foi à busca ou à camada fica onde está.
  useLayoutEffect(() => {
    const target = pending.current;
    if (target === null || (target.layer === layer && shown.includes(target.word))) return;
    pending.current = null;
    if (target.layer !== layer) return;
    const active = document.activeElement;
    if (active && active !== document.body && !listRef.current?.contains(active)) return;
    const buttons = listRef.current?.querySelectorAll<HTMLButtonElement>('button[data-word]');
    const next = buttons?.[Math.min(target.index, buttons.length - 1)];
    (
      next ??
      searchRef.current ??
      groupRef.current?.querySelector<HTMLInputElement>('input[type="radio"]:checked')
    )?.focus();
  });

  const remove = async (word: string, index: number) => {
    if (removing.current) return;
    removing.current = true;
    const target = layer;
    pending.current = { layer: target, word, index };
    setBusy(true);
    setError(null);
    const result = await source.remove(word, target);
    removing.current = false;
    setBusy(false);
    if (result.status === 'removed' || result.status === 'absent') {
      setAnnouncement(
        result.status === 'removed'
          ? `“${word}” removida do dicionário ${WHERE[target]}.`
          : `“${word}” já não estava no dicionário ${WHERE[target]}.`,
      );
      return;
    }
    pending.current = null;
    // Um alerta com texto por vez: o erro da lista de palavras tira o de "Listas importadas".
    setListError(null);
    setError({ word, text: `Não foi possível remover “${word}” — ${failure(result)}` });
  };

  /** Abre o campo de renomear da lista, com o nome atual selecionado. */
  const startRename = (file: DictionaryEditorFile, index: number) => {
    setRow({ kind: 'rename', name: file.name });
    setDraft(listLabel(file.name));
    setListError(null);
    listFocus.current = { layer, name: file.name, control: 'field', index, removed: false };
  };

  /** 1º passo de remover uma lista: a pergunta e "Confirmar remoção" no lugar dos botões. */
  const startRemove = (file: DictionaryEditorFile, index: number) => {
    setRow({ kind: 'confirm', name: file.name });
    setListError(null);
    listFocus.current = { layer, name: file.name, control: 'confirm', index, removed: false };
  };

  /** Esc ou "Cancelar": desfaz o campo ou o 2º passo, e o foco volta ao botão que o abriu. */
  const closeRow = (open: ListRow) => {
    const index = files.findIndex((file) => file.name === open.name);
    setRow(null);
    setListError(null);
    listFocus.current = {
      layer,
      name: open.name,
      control: open.kind === 'rename' ? 'rename' : 'remove',
      index,
      removed: false,
    };
  };

  const importList = async () => {
    if (working.current) return;
    working.current = true;
    const target = layer;
    setRow(null);
    setListBusy(true);
    setListError(null);
    setListStatus('');
    const result = await source.import(target);
    working.current = false;
    setListBusy(false);
    if (result.status === 'imported') setListStatus(result.summary);
    else if (result.status !== 'cancelled') {
      setError(null);
      setListError({
        control: 'import',
        name: null,
        text: `Não foi possível importar a lista — ${failure(result)}`,
      });
    }
  };

  const rename = async (file: DictionaryEditorFile, index: number) => {
    if (working.current) return;
    working.current = true;
    const target = layer;
    setListBusy(true);
    setListError(null);
    setListStatus('');
    const result = await source.rename(target, file.name, draft);
    working.current = false;
    setListBusy(false);
    const label = listLabel(file.name);
    if (result.status === 'renamed') {
      setRow(null);
      listFocus.current = {
        layer: target,
        name: result.name,
        control: 'rename',
        index,
        removed: false,
      };
      // Mesmo nome (o serviço nem chama o Rust): o campo fecha e o status diz que nada mudou.
      setListStatus(
        result.name === file.name
          ? `O nome de “${label}” não mudou.`
          : `Lista “${label}” renomeada para “${listLabel(result.name)}”.`,
      );
      return;
    }
    // O campo fica, com o erro e o texto selecionado; se a lista saiu (`NOT_FOUND`), ele fecha e o
    // foco vai ao lugar dela.
    if (!source.getSnapshot()[target].files.some((item) => item.name === file.name)) setRow(null);
    listFocus.current = { layer: target, name: file.name, control: 'field', index, removed: false };
    setError(null);
    setListError({
      control: 'field',
      name: file.name,
      text: `Não foi possível renomear “${label}” — ${failure(result)}`,
    });
  };

  const removeList = async (file: DictionaryEditorFile, index: number) => {
    if (working.current) return;
    working.current = true;
    const target = layer;
    listFocus.current = { layer: target, name: file.name, control: 'remove', index, removed: true };
    setListBusy(true);
    setListError(null);
    setListStatus('');
    const result = await source.removeList(target, file.name);
    working.current = false;
    setListBusy(false);
    setRow(null);
    const label = listLabel(file.name);
    if (result.status === 'removed') {
      setListStatus(`Lista “${label}” removida do dicionário ${WHERE[target]}.`);
      // A lista continua na camada relida (outro programa a recriou nesse meio): o foco pedido
      // resolve agora, no "Remover" dela, em vez de esperar uma saída que roubaria o foco depois.
      if (source.getSnapshot()[target].files.some((item) => item.name === file.name))
        listFocus.current = {
          layer: target,
          name: file.name,
          control: 'remove',
          index,
          removed: false,
        };
      return;
    }
    listFocus.current = {
      layer: target,
      name: file.name,
      control: 'remove',
      index,
      removed: false,
    };
    setError(null);
    setListError({
      control: 'remove',
      name: file.name,
      text: `Não foi possível remover “${label}” — ${failure(result)}`,
    });
  };

  // "Listas importadas": o foco vai ao controle pedido quando ele aparece ou, se a lista saiu, ao
  // "Remover" da que ocupou o lugar dela. Só se o foco segue nas listas ou caiu — no `body` ou no
  // contêiner (um ancestral das listas) que a armadilha de foco do diálogo das Configurações escolhe
  // quando o elemento focado sai do DOM, como o campo de renomear quando a camada é relida antes de
  // o `rename` resolver; quem já foi a outro controle fica onde está.
  useLayoutEffect(() => {
    const want = listFocus.current;
    if (want === null) return;
    const present = files.some((file) => file.name === want.name);
    if (want.layer === layer && want.removed && present) return;
    listFocus.current = null;
    const box = listsRef.current;
    if (want.layer !== layer || box === null) return;
    const active = document.activeElement;
    if (active !== null && !box.contains(active) && !active.contains(box)) return;
    const controls = [...box.querySelectorAll<HTMLElement>('[data-list]')];
    const target = controls.find(
      (control) => control.dataset.list === want.name && control.dataset.control === want.control,
    );
    if (target) {
      target.focus();
      if (target instanceof HTMLInputElement) target.select();
      return;
    }
    if (present) return;
    const removes = controls.filter((control) => control.dataset.control === 'remove');
    (removes[Math.min(want.index, removes.length - 1)] ?? importRef.current)?.focus();
  });

  // Esc no campo de renomear ou no 2º passo de remover desfaz só ele. O diálogo das Configurações
  // (Radix) fecha com Esc num ouvinte de captura do `document`; este, na captura da `window`, roda
  // antes e marca o evento como tratado, então o diálogo continua aberto.
  useEffect(() => {
    if (editing === null) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing || event.defaultPrevented) return;
      if (!(event.target instanceof Node) || !rowRef.current?.contains(event.target)) return;
      event.preventDefault();
      closeRow(editing);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  });

  return (
    <div
      ref={groupRef}
      role="group"
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      className="smd-dict"
      data-testid="dictionary-editor"
      data-layer={layer}
    >
      <fieldset className="smd-dict-layers">
        <legend>Camada</legend>
        <div className="smd-field-inline">
          {LAYERS.map((option) => (
            <label key={option.value} className="smd-radio">
              <input
                type="radio"
                name={`${base}-layer`}
                value={option.value}
                checked={layer === option.value}
                onChange={() => {
                  setLayer(option.value);
                  setError(null);
                  setRow(null);
                  setListError(null);
                  setListStatus('');
                }}
              />
              {option.label}
            </label>
          ))}
        </div>
      </fieldset>
      {/* Os avisos do serviço vêm em minúsculas (seguem o nome do plugin); aqui viram frase. */}
      {view.warnings.map((warning) => (
        <p key={warning.id} className="smd-hint smd-dict-warning" data-testid="dictionary-warning">
          <Icon name="warn" />
          {warning.text.charAt(0).toLocaleUpperCase('pt-BR') + warning.text.slice(1)}
        </p>
      ))}
      {view.status === 'none' ? (
        <p className="smd-muted" data-testid="dictionary-empty">
          Abra uma pasta para ver o dicionário dela.
        </p>
      ) : (
        <>
          <div className="smd-dict-find">
            <div className="smd-field-inline">
              <label htmlFor={searchId}>Buscar</label>
              <input
                ref={searchRef}
                id={searchId}
                type="search"
                className="smd-input smd-dict-search"
                autoComplete="off"
                spellCheck={false}
                data-testid="dictionary-search"
                value={query}
                onChange={(event) => {
                  // A busca mudou: a remoção pendente já não leva o foco a lugar nenhum.
                  pending.current = null;
                  setQuery(event.target.value);
                }}
              />
            </div>
            {/* Sempre no DOM (região viva); vazio não ocupa espaço. */}
            <p id={errorId} className="smd-field-error smd-dict-error" role="alert">
              {error && (
                <>
                  <Icon name="warn" />
                  {error.text}
                </>
              )}
            </p>
          </div>
          {loading ? (
            <p className="smd-hint">Carregando o dicionário…</p>
          ) : shown.length > 0 ? (
            <>
              <p id={countId} className="smd-hint smd-dict-count" data-testid="dictionary-count">
                {count}
              </p>
              {/* `role="list"`: o WebKit tira a semântica de lista de um `ul` sem marcadores. */}
              <ul
                ref={listRef}
                role="list"
                className="smd-dict-list"
                aria-label={`Palavras do dicionário ${where}`}
                aria-describedby={countId}
                aria-busy={busy || undefined}
              >
                {shown.map((word, index) => (
                  <li key={word} className="smd-dict-item">
                    <span className="smd-dict-word">{word}</span>
                    <Button
                      className="smd-btn-compact"
                      data-word={word}
                      aria-label={`Remover “${word}”`}
                      aria-describedby={error?.word === word ? errorId : undefined}
                      onClick={() => void remove(word, index)}
                    >
                      Remover
                    </Button>
                  </li>
                ))}
              </ul>
            </>
          ) : filtering ? (
            <p className="smd-muted" data-testid="dictionary-empty">
              Nenhuma palavra corresponde a “{query.trim()}”.
            </p>
          ) : view.status === 'error' ? null : (
            <p className="smd-muted" data-testid="dictionary-empty">
              Nenhuma palavra no dicionário {where}.
            </p>
          )}
        </>
      )}
      <div
        ref={listsRef}
        role="group"
        aria-labelledby={listsTitleId}
        aria-busy={listBusy || undefined}
        className="smd-dict"
        data-testid="dictionary-lists"
      >
        <p id={listsTitleId}>Listas importadas</p>
        <div className="smd-field-inline">
          <Button
            ref={importRef}
            className="smd-btn-compact"
            data-testid="dictionary-import"
            aria-disabled={noFolder || undefined}
            aria-describedby={idList(
              destinationId,
              noFolder && reasonId,
              listError?.control === 'import' && listErrorId,
            )}
            onClick={() => void importList()}
          >
            Importar lista de termos…
          </Button>
          <span id={destinationId} className="smd-hint">
            Vai para: {destination}
          </span>
        </div>
        {noFolder && (
          <p id={reasonId} className="smd-hint" data-testid="dictionary-import-reason">
            Sem pasta aberta: abra uma pasta para importar uma lista para ela.
          </p>
        )}
        {/*
          O status fica sempre no DOM (região viva educada; vazio, não ocupa espaço). O alerta só
          existe com um erro: um `role="alert"` inserido já é lido. Um alerta com texto por vez: o
          erro de uma lista tira o da lista de palavras, e vice-versa.
        */}
        <div>
          <p className="smd-hint" role="status" data-testid="dictionary-lists-status">
            {listStatus}
          </p>
          {listError && (
            <p
              id={listErrorId}
              className="smd-field-error smd-dict-error"
              role="alert"
              data-testid="dictionary-lists-error"
            >
              <Icon name="warn" />
              {listError.text}
            </p>
          )}
        </div>
        {loading || noFolder ? null : files.length > 0 ? (
          <ul
            role="list"
            className="smd-dict-list"
            aria-label={`Listas importadas do dicionário ${where}`}
          >
            {files.map((file, index) => {
              const label = listLabel(file.name);
              if (editing?.name === file.name && editing.kind === 'rename')
                return (
                  <li key={file.name} ref={rowRef} className="smd-dict-item">
                    <div className="smd-field">
                      <div className="smd-field-inline">
                        <label htmlFor={fieldId}>
                          Novo nome <span className="sr-only">de “{label}”</span>
                        </label>
                        <input
                          id={fieldId}
                          className="smd-input"
                          data-list={file.name}
                          data-control="field"
                          autoComplete="off"
                          spellCheck={false}
                          value={draft}
                          aria-invalid={listError?.control === 'field' || undefined}
                          aria-describedby={idList(
                            fieldHintId,
                            listError?.control === 'field' && listErrorId,
                          )}
                          onChange={(event) => setDraft(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
                            event.preventDefault();
                            void rename(file, index);
                          }}
                        />
                      </div>
                      <p id={fieldHintId} className="smd-hint">
                        Enter renomeia; Esc cancela.
                      </p>
                    </div>
                  </li>
                );
              if (editing?.name === file.name)
                return (
                  <li key={file.name} ref={rowRef} className="smd-dict-item">
                    <span id={questionId} className="smd-dict-word">
                      {removeQuestion(label, file.words)}
                    </span>
                    <span className="smd-field-inline">
                      <Button
                        className="smd-btn-compact"
                        data-list={file.name}
                        data-control="confirm"
                        aria-describedby={questionId}
                        onClick={() => void removeList(file, index)}
                      >
                        Confirmar remoção
                      </Button>
                      <Button
                        className="smd-btn-compact"
                        data-list={file.name}
                        data-control="cancel"
                        onClick={() => closeRow(editing)}
                      >
                        Cancelar
                      </Button>
                    </span>
                  </li>
                );
              return (
                <li key={file.name} className="smd-dict-item">
                  <span className="smd-dict-word">
                    {label} <span className="smd-hint">{wordCount(file.words)}</span>
                  </span>
                  <span className="smd-field-inline">
                    <Button
                      className="smd-btn-compact"
                      data-list={file.name}
                      data-control="rename"
                      aria-label={`Renomear “${label}”`}
                      onClick={() => startRename(file, index)}
                    >
                      Renomear
                    </Button>
                    <Button
                      className="smd-btn-compact"
                      data-list={file.name}
                      data-control="remove"
                      aria-label={`Remover “${label}”`}
                      aria-describedby={
                        listError?.control === 'remove' && listError.name === file.name
                          ? listErrorId
                          : undefined
                      }
                      onClick={() => startRemove(file, index)}
                    >
                      Remover
                    </Button>
                  </span>
                </li>
              );
            })}
          </ul>
        ) : view.status === 'error' ? null : (
          <p className="smd-muted" data-testid="dictionary-lists-empty">
            Nenhuma lista importada no dicionário {where}.
          </p>
        )}
      </div>
      <p className="sr-only" role="status" data-testid="dictionary-live">
        {announcement}
      </p>
    </div>
  );
}
