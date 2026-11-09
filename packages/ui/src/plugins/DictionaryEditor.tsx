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
 * O serviço de dicionário do app visto pela lista (r32b, `AppController.dictionary`): a primeira
 * assinatura começa a carga, o snapshot é imutável (`useSyncExternalStore`) e `remove` tira a
 * palavra de todos os `.txt` lidos da camada (D-R32-6), sem nunca rejeitar.
 */
export interface DictionaryEditorSource {
  subscribe(listener: () => void): () => void;
  getSnapshot(): DictionaryEditorSnapshot;
  remove(word: string, layer: DictionaryEditorLayer): Promise<DictionaryEditorRemoveResult>;
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

function failure(result: DictionaryEditorRemoveResult): string {
  if (result.status === 'failed') return result.message;
  if (result.status === 'no-folder') return 'nenhuma pasta aberta';
  return 'a palavra está fora do formato do dicionário';
}

/**
 * Lista do dicionário do usuário (r32c; design-r32 §1; opção `dictionary` do LanguageTool em
 * Configurações → Plugins): escolher a camada, buscar (sem acento nem caixa) e ver até 100 palavras,
 * cada uma com "Remover “<palavra>”". Remover tira a palavra de todos os `.txt` da camada (D-R32-6)
 * e leva o foco à palavra seguinte (à anterior na última; à busca quando a lista esvazia). Funciona
 * com o plugin desligado: lê e grava pelo serviço do app. As palavras e os avisos vêm de arquivos
 * da pasta (entrada não confiável) e só entram como texto.
 */
export function DictionaryEditor({ source, labelledBy, describedBy }: DictionaryEditorProps) {
  const base = useId();
  const searchId = `${base}-search`;
  const errorId = `${base}-error`;
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
  // próximo botão; sem botões, à busca ou à camada escolhida (sem pasta, a busca também sai).
  useLayoutEffect(() => {
    const target = pending.current;
    if (target === null || (target.layer === layer && shown.includes(target.word))) return;
    pending.current = null;
    if (target.layer !== layer) return;
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
    setError({ word, text: `Não foi possível remover “${word}” — ${failure(result)}` });
  };

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
                onChange={(event) => setQuery(event.target.value)}
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
              <p
                className="smd-hint smd-dict-count"
                aria-hidden="true"
                data-testid="dictionary-count"
              >
                {count}
              </p>
              {/* `role="list"`: o WebKit tira a semântica de lista de um `ul` sem marcadores. */}
              <ul
                ref={listRef}
                role="list"
                className="smd-dict-list"
                aria-label={`Palavras do dicionário ${where}`}
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
      <p className="sr-only" role="status" data-testid="dictionary-live">
        {announcement}
      </p>
    </div>
  );
}
