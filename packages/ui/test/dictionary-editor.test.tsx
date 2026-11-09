import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  DICTIONARY_LIST_MAX,
  DictionaryEditor,
  type DictionaryEditorFile,
  type DictionaryEditorImportResult,
  type DictionaryEditorLayer,
  type DictionaryEditorLayerView,
  type DictionaryEditorListResult,
  type DictionaryEditorRemoveResult,
  type DictionaryEditorSnapshot,
  type DictionaryEditorSource,
} from '../src/plugins/DictionaryEditor';
import { PluginOptions } from '../src/plugins/PluginOptions';

/**
 * r32c — lista do dicionário (AC-R32-1 remover, AC-R32-4): nomes acessíveis, camada, busca, teto de
 * 100, foco depois de remover, estados (carregando, sem pasta, vazio, erro) e a opção `dictionary`
 * no `PluginOptions`. O serviço é um falso com a forma do `app.dictionary` (r32b). r33b: "Listas
 * importadas" (importar, renomear, remover em dois passos, foco, status/alerta, sem pasta).
 */
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const ready = (
  terms: readonly string[],
  warnings: DictionaryEditorLayerView['warnings'] = [],
  files: readonly DictionaryEditorFile[] = [],
): DictionaryEditorLayerView => ({ status: 'ready', terms, warnings, files });

/** Camada da pasta sem pasta aberta. */
const NO_FOLDER: DictionaryEditorLayerView = { status: 'none', terms: [], warnings: [], files: [] };

/**
 * Falso do serviço: snapshot imutável; `remove` tira a palavra da camada e avisa os assinantes. r33:
 * `import` acrescenta `termos-medicos.txt` (50.000 palavras), `rename` troca o nome da lista (o
 * digitado + `.txt`) e `removeList` a tira; como no serviço, a camada muda antes de resolver.
 */
function fakeDictionary(initial: Partial<DictionaryEditorSnapshot> = {}) {
  let snapshot: DictionaryEditorSnapshot = { global: ready([]), folder: ready([]), ...initial };
  const listeners = new Set<() => void>();
  const set = (patch: Partial<DictionaryEditorSnapshot>) => {
    snapshot = { ...snapshot, ...patch };
    for (const listener of [...listeners]) listener();
  };
  const without = (layer: DictionaryEditorLayer, word: string) =>
    set({
      [layer]: { ...snapshot[layer], terms: snapshot[layer].terms.filter((t) => t !== word) },
    });
  const lists = (
    layer: DictionaryEditorLayer,
    change: (files: readonly DictionaryEditorFile[]) => readonly DictionaryEditorFile[],
  ) => set({ [layer]: { ...snapshot[layer], files: change(snapshot[layer].files) } });
  const source = {
    subscribe: vi.fn((listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }),
    getSnapshot: () => snapshot,
    remove: vi.fn(
      async (word: string, layer: DictionaryEditorLayer): Promise<DictionaryEditorRemoveResult> => {
        if (!snapshot[layer].terms.includes(word)) return { status: 'absent' };
        without(layer, word);
        return { status: 'removed' };
      },
    ),
    import: vi.fn(async (layer: DictionaryEditorLayer): Promise<DictionaryEditorImportResult> => {
      const name = 'termos-medicos.txt';
      lists(layer, (files) => [...files, { name, words: 50_000 }]);
      return {
        status: 'imported',
        name,
        summary: '“termos-medicos” importado: 50.000 palavras (lido como UTF-8).',
      };
    }),
    rename: vi.fn(
      async (
        layer: DictionaryEditorLayer,
        name: string,
        to: string,
      ): Promise<DictionaryEditorListResult> => {
        const next = `${to.trim()}.txt`;
        lists(layer, (files) => files.map((f) => (f.name === name ? { ...f, name: next } : f)));
        return { status: 'renamed', name: next };
      },
    ),
    removeList: vi.fn(
      async (layer: DictionaryEditorLayer, name: string): Promise<DictionaryEditorListResult> => {
        lists(layer, (files) => files.filter((f) => f.name !== name));
        return { status: 'removed' };
      },
    ),
  };
  return { source, set, without, listeners };
}

function renderEditor(source: DictionaryEditorSource) {
  return render(
    <>
      <span id="dict-label">Dicionário</span>
      <p id="dict-help">Palavras que não são sublinhadas.</p>
      <DictionaryEditor source={source} labelledBy="dict-label" describedBy="dict-help" />
    </>,
  );
}

const removeButton = (word: string) => screen.getByRole('button', { name: `Remover “${word}”` });
const live = () => screen.getByTestId('dictionary-live').textContent;

async function click(element: HTMLElement) {
  element.focus();
  await act(async () => {
    element.click();
  });
}

describe('nomes e estrutura (AC-R32-4)', () => {
  test('grupo "Dicionário" com a ajuda; camada num fieldset; busca rotulada; lista com "Remover “x”"', () => {
    const fake = fakeDictionary({ global: ready(['excessão', 'Brasil', 'clínica']) });
    const { unmount } = renderEditor(fake.source);
    const group = screen.getByRole('group', {
      name: 'Dicionário',
      description: 'Palavras que não são sublinhadas.',
    });
    expect(group.dataset.testid).toBe('dictionary-editor');
    const layers = screen.getByRole('group', { name: 'Camada' });
    expect(layers.tagName).toBe('FIELDSET');
    expect(within(layers).getByRole('radio', { name: 'Este computador' })).toHaveProperty(
      'checked',
      true,
    );
    expect(within(layers).getByRole('radio', { name: 'Esta pasta' })).toHaveProperty(
      'checked',
      false,
    );
    expect(screen.getByRole('searchbox', { name: 'Buscar' })).toBeTruthy();
    const list = screen.getByRole('list', { name: 'Palavras do dicionário deste computador' });
    const items = within(list).getAllByRole('listitem');
    expect(items.map((item) => item.querySelector('.smd-dict-word')?.textContent)).toEqual([
      'excessão',
      'Brasil',
      'clínica',
    ]);
    // Botão nativo (Enter e Espaço acionam) com o texto visível "Remover" dentro do nome.
    const button = removeButton('Brasil');
    expect([button.tagName, button.getAttribute('type'), button.textContent]).toEqual([
      'BUTTON',
      'button',
      'Remover',
    ]);
    expect(screen.getByTestId('dictionary-count').textContent).toBe('3 palavras.');
    // A primeira assinatura é o que começa a carga do serviço; ao desmontar, ela sai.
    expect(fake.source.subscribe).toHaveBeenCalledTimes(1);
    expect(fake.listeners.size).toBe(1);
    unmount();
    expect(fake.listeners.size).toBe(0);
  });

  test('"Esta pasta" mostra a camada da pasta; sem pasta, "Abra uma pasta…"; vazia, a mensagem da camada', async () => {
    const fake = fakeDictionary({ global: ready(['global']), folder: ready(['pasta1', 'pasta2']) });
    renderEditor(fake.source);
    await click(screen.getByRole('radio', { name: 'Esta pasta' }));
    expect(screen.getByRole('radio', { name: 'Esta pasta' })).toHaveProperty('checked', true);
    const list = screen.getByRole('list', { name: 'Palavras do dicionário desta pasta' });
    expect(
      within(list)
        .getAllByRole('button')
        .map((b) => b.getAttribute('aria-label')),
    ).toEqual(['Remover “pasta1”', 'Remover “pasta2”']);
    act(() => fake.set({ folder: NO_FOLDER }));
    expect(screen.getByTestId('dictionary-empty').textContent).toBe(
      'Abra uma pasta para ver o dicionário dela.',
    );
    expect(screen.queryByRole('searchbox')).toBeNull();
    act(() => fake.set({ folder: ready([]) }));
    expect(screen.getByTestId('dictionary-empty').textContent).toBe(
      'Nenhuma palavra no dicionário desta pasta.',
    );
    await click(screen.getByRole('radio', { name: 'Este computador' }));
    expect(removeButton('global')).toBeTruthy();
  });
});

describe('busca e teto de 100', () => {
  test('sem acento nem caixa; "N de M palavras"; sem resultado; a contagem é anunciada 500 ms depois', () => {
    vi.useFakeTimers();
    const fake = fakeDictionary({ global: ready(['excessão', 'Brasil', 'clínica']) });
    renderEditor(fake.source);
    const search = screen.getByRole('searchbox', { name: 'Buscar' });
    fireEvent.change(search, { target: { value: 'EXCESSAO' } });
    expect(screen.getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      'excessãoRemover',
    ]);
    expect(screen.getByTestId('dictionary-count').textContent).toBe('1 de 3 palavras.');
    act(() => vi.advanceTimersByTime(499));
    expect(live()).toBe('');
    act(() => vi.advanceTimersByTime(1));
    expect(live()).toBe('1 de 3 palavras.');
    fireEvent.change(search, { target: { value: ' brás ' } });
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    expect(removeButton('Brasil')).toBeTruthy();
    fireEvent.change(search, { target: { value: 'zzz' } });
    expect(screen.queryByRole('list')).toBeNull();
    expect(screen.getByTestId('dictionary-empty').textContent).toBe(
      'Nenhuma palavra corresponde a “zzz”.',
    );
    act(() => vi.advanceTimersByTime(500));
    expect(live()).toBe('0 de 3 palavras.');
  });

  test(`${DICTIONARY_LIST_MAX} itens no máximo; a busca alcança os de depois`, () => {
    const terms = Array.from({ length: 150 }, (_, i) => `palavra${i}`);
    const fake = fakeDictionary({ global: ready(terms) });
    renderEditor(fake.source);
    expect(screen.getAllByRole('button', { name: /^Remover “/ })).toHaveLength(100);
    expect(screen.queryByRole('button', { name: 'Remover “palavra100”' })).toBeNull();
    expect(screen.getByTestId('dictionary-count').textContent).toBe(
      '150 palavras. Mostrando as 100 primeiras; busque para achar as outras.',
    );
    // O corte chega ao leitor de tela: o texto não é escondido e descreve a lista.
    const count = screen.getByTestId('dictionary-count');
    expect(count.hasAttribute('aria-hidden')).toBe(false);
    expect(
      screen.getByRole('list', {
        description: '150 palavras. Mostrando as 100 primeiras; busque para achar as outras.',
      }),
    ).toBeTruthy();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Buscar' }), {
      target: { value: 'palavra14' },
    });
    expect(screen.getAllByRole('button', { name: /^Remover “/ })).toHaveLength(11);
    expect(removeButton('palavra149')).toBeTruthy();
    expect(screen.getByTestId('dictionary-count').textContent).toBe('11 de 150 palavras.');
    fireEvent.change(screen.getByRole('searchbox', { name: 'Buscar' }), {
      target: { value: 'palavra' },
    });
    expect(screen.getByTestId('dictionary-count').textContent).toBe(
      '150 de 150 palavras. Mostrando as 100 primeiras; refine a busca.',
    );
  });
});

describe('remover (AC-R32-1, D-R32-6) e foco', () => {
  test('remove(palavra, camada), anúncio e foco na próxima; na última, na anterior; lista vazia, na busca', async () => {
    const fake = fakeDictionary({ folder: ready(['alfa', 'beta', 'gama']) });
    renderEditor(fake.source);
    await click(screen.getByRole('radio', { name: 'Esta pasta' }));
    await click(removeButton('beta'));
    expect(fake.source.remove).toHaveBeenLastCalledWith('beta', 'folder');
    expect(screen.queryByRole('button', { name: 'Remover “beta”' })).toBeNull();
    expect(document.activeElement).toBe(removeButton('gama'));
    expect(live()).toBe('“beta” removida do dicionário desta pasta.');
    await click(removeButton('gama'));
    expect(document.activeElement).toBe(removeButton('alfa'));
    expect(live()).toBe('“gama” removida do dicionário desta pasta.');
    await click(removeButton('alfa'));
    expect(screen.getByTestId('dictionary-empty').textContent).toBe(
      'Nenhuma palavra no dicionário desta pasta.',
    );
    expect(document.activeElement).toBe(screen.getByRole('searchbox', { name: 'Buscar' }));
    expect(fake.source.remove).toHaveBeenCalledTimes(3);
  });

  test('a palavra saiu por fora ("absent"): anuncia que já não estava e o foco segue', async () => {
    const fake = fakeDictionary({ global: ready(['alfa', 'beta']) });
    fake.source.remove.mockImplementationOnce(async (word, layer) => {
      fake.without(layer, word);
      return { status: 'absent' };
    });
    renderEditor(fake.source);
    await click(removeButton('alfa'));
    expect(live()).toBe('“alfa” já não estava no dicionário deste computador.');
    expect(document.activeElement).toBe(removeButton('beta'));
  });

  test('falha: erro em linha (role=alert) ligado ao botão; a palavra e o foco ficam; o próximo sucesso limpa', async () => {
    const fake = fakeDictionary({ global: ready(['alfa', 'beta']) });
    fake.source.remove.mockResolvedValueOnce({ status: 'failed', message: 'Dicionário falso: IO' });
    renderEditor(fake.source);
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toBe('');
    await click(removeButton('beta'));
    expect(alert.textContent).toBe('Não foi possível remover “beta” — Dicionário falso: IO');
    expect(alert.querySelector('svg.smd-icon')).not.toBeNull();
    const beta = removeButton('beta');
    expect(document.activeElement).toBe(beta);
    expect(beta.getAttribute('aria-describedby')).toBe(alert.id);
    expect(live()).toBe('');
    fake.source.remove.mockResolvedValueOnce({ status: 'no-folder' });
    await click(removeButton('alfa'));
    expect(alert.textContent).toBe('Não foi possível remover “alfa” — nenhuma pasta aberta');
    expect(removeButton('beta').hasAttribute('aria-describedby')).toBe(false);
    await click(removeButton('beta'));
    expect(alert.textContent).toBe('');
    expect(document.activeElement).toBe(removeButton('alfa'));
  });

  test('clique repetido durante a remoção pede uma só', async () => {
    const fake = fakeDictionary({ global: ready(['alfa', 'beta']) });
    const pending = Promise.withResolvers<DictionaryEditorRemoveResult>();
    fake.source.remove.mockImplementationOnce(async (word, layer) => {
      const result = await pending.promise;
      fake.without(layer, word);
      return result;
    });
    renderEditor(fake.source);
    const alfa = removeButton('alfa');
    await click(alfa);
    expect(screen.getByRole('list').getAttribute('aria-busy')).toBe('true');
    await act(async () => {
      alfa.click();
      removeButton('beta').click();
    });
    expect(fake.source.remove).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(alfa);
    await act(async () => pending.resolve({ status: 'removed' }));
    expect(screen.getByRole('list').hasAttribute('aria-busy')).toBe(false);
    expect(document.activeElement).toBe(removeButton('beta'));
  });

  test('remoção lenta: digitar na busca enquanto isso deixa o foco na busca', async () => {
    const fake = fakeDictionary({ global: ready(['alfa', 'beta', 'gama']) });
    const pending = Promise.withResolvers<DictionaryEditorRemoveResult>();
    fake.source.remove.mockImplementationOnce(async (word, layer) => {
      const result = await pending.promise;
      fake.without(layer, word);
      return result;
    });
    renderEditor(fake.source);
    await click(removeButton('alfa'));
    const search = screen.getByRole('searchbox', { name: 'Buscar' });
    search.focus();
    fireEvent.change(search, { target: { value: 'bet' } });
    expect(document.activeElement).toBe(search);
    await act(async () => pending.resolve({ status: 'removed' }));
    expect(live()).toBe('“alfa” removida do dicionário deste computador.');
    expect(document.activeElement).toBe(search);
  });

  test('remoção lenta: o foco que já foi à busca não volta para a lista', async () => {
    const fake = fakeDictionary({ global: ready(['alfa', 'beta']) });
    const pending = Promise.withResolvers<DictionaryEditorRemoveResult>();
    fake.source.remove.mockImplementationOnce(async (word, layer) => {
      const result = await pending.promise;
      fake.without(layer, word);
      return result;
    });
    renderEditor(fake.source);
    await click(removeButton('alfa'));
    const search = screen.getByRole('searchbox', { name: 'Buscar' });
    search.focus();
    await act(async () => pending.resolve({ status: 'removed' }));
    expect(screen.queryByRole('button', { name: 'Remover “alfa”' })).toBeNull();
    expect(document.activeElement).toBe(search);
  });

  test('remoção lenta: depois de mexer na busca, a remoção não puxa o foco perdido para a lista', async () => {
    const fake = fakeDictionary({ global: ready(['alfa', 'beta']) });
    const pending = Promise.withResolvers<DictionaryEditorRemoveResult>();
    fake.source.remove.mockImplementationOnce(async (word, layer) => {
      const result = await pending.promise;
      fake.without(layer, word);
      return result;
    });
    renderEditor(fake.source);
    await click(removeButton('alfa'));
    const search = screen.getByRole('searchbox', { name: 'Buscar' });
    search.focus();
    // "a" ainda mostra "alfa"; depois o foco sai para o nada (clique fora da janela, por exemplo).
    fireEvent.change(search, { target: { value: 'a' } });
    search.blur();
    await act(async () => pending.resolve({ status: 'removed' }));
    expect(document.activeElement).toBe(document.body);
  });
});

describe('estados e entrada não confiável', () => {
  test('carregando; erro de leitura com o aviso e a lista anterior; avisos viram frase', () => {
    const fake = fakeDictionary({
      global: { status: 'loading', terms: [], warnings: [], files: [] },
    });
    renderEditor(fake.source);
    expect(screen.getByText('Carregando o dicionário…')).toBeTruthy();
    expect(screen.queryByRole('list')).toBeNull();
    const read = {
      id: 'global:read',
      text: 'não foi possível ler o dicionário deste computador (IO).',
    };
    act(() =>
      fake.set({ global: { status: 'error', terms: ['alfa'], warnings: [read], files: [] } }),
    );
    expect(screen.getByTestId('dictionary-warning').textContent).toBe(
      'Não foi possível ler o dicionário deste computador (IO).',
    );
    expect(removeButton('alfa')).toBeTruthy();
    // Sem palavras da leitura anterior: só o aviso, nunca "Nenhuma palavra…".
    act(() => fake.set({ global: { status: 'error', terms: [], warnings: [read], files: [] } }));
    expect(screen.queryByTestId('dictionary-empty')).toBeNull();
  });

  test('palavra e aviso (de arquivos da pasta) só como texto', () => {
    const fake = fakeDictionary({
      global: ready(
        ['<img/src=x>'],
        [
          {
            id: 'global:file:x',
            text: 'o arquivo “<b>x</b>.txt” ficou de fora: não está em UTF-8.',
          },
        ],
      ),
    });
    const { container } = renderEditor(fake.source);
    expect(container.querySelector('img, b')).toBeNull();
    expect(removeButton('<img/src=x>')).toBeTruthy();
    expect(screen.getByTestId('dictionary-warning').textContent).toContain('“<b>x</b>.txt”');
  });
});

describe('opção `dictionary` no PluginOptions', () => {
  const field = {
    key: 'userDictionary',
    kind: 'dictionary' as const,
    label: 'Dicionário',
    help: 'Remover tira a palavra de todos os arquivos .txt da camada.',
  };

  test('com o serviço: o editor é rotulado pelo rótulo e pela ajuda; remover não passa pelo onChange', async () => {
    const fake = fakeDictionary({ global: ready(['alfa']) });
    const onChange = vi.fn(async () => ({ ok: true as const }));
    render(
      <PluginOptions
        id="opts"
        pluginId="simplemd.languagetool"
        pluginName="LanguageTool"
        onChange={onChange}
        data={{ fields: [field], values: {}, info: async () => '', dictionary: fake.source }}
      />,
    );
    const row = document.querySelector('[data-key="userDictionary"]');
    expect(row?.className).toBe('smd-plugin-option smd-plugin-option-block');
    expect(
      screen.getByRole('group', {
        name: 'Dicionário',
        description: 'Remover tira a palavra de todos os arquivos .txt da camada.',
      }).dataset.testid,
    ).toBe('dictionary-editor');
    await click(removeButton('alfa'));
    expect(fake.source.remove).toHaveBeenCalledWith('alfa', 'global');
    expect(onChange).not.toHaveBeenCalled();
  });

  test('sem o serviço, a opção não aparece', () => {
    render(
      <PluginOptions
        id="opts"
        pluginId="simplemd.languagetool"
        pluginName="LanguageTool"
        onChange={vi.fn()}
        data={{ fields: [field], values: {}, info: async () => '' }}
      />,
    );
    expect(document.querySelector('[data-key="userDictionary"]')).toBeNull();
    expect(screen.queryByTestId('dictionary-editor')).toBeNull();
  });
});

describe('r33b: listas importadas (design-r33 §1)', () => {
  const lists: readonly DictionaryEditorFile[] = [
    { name: 'cardiologia.txt', words: 1_200 },
    { name: 'termos-medicos.txt', words: 50_000 },
    { name: 'uma.txt', words: 1 },
    { name: 'quebrada.txt', words: null },
  ];
  const importButton = () => screen.getByRole('button', { name: 'Importar lista de termos…' });
  const section = () => screen.getByRole('group', { name: 'Listas importadas' });
  const listsStatus = () => screen.getByTestId('dictionary-lists-status').textContent;
  const listsAlert = () => screen.getByTestId('dictionary-lists-error');
  const button = (name: string) => screen.getByRole('button', { name });

  test('cada lista com "N palavras", "Renomear “x”" e "Remover “x”"; "Vai para" acompanha a camada', async () => {
    const fake = fakeDictionary({ global: ready(['alfa'], [], lists) });
    renderEditor(fake.source);
    const list = within(section()).getByRole('list', {
      name: 'Listas importadas do dicionário deste computador',
    });
    expect(
      within(list)
        .getAllByRole('listitem')
        .map((item) => item.querySelector('.smd-dict-word')?.textContent),
    ).toEqual([
      'cardiologia 1.200 palavras',
      'termos-medicos 50.000 palavras',
      'uma 1 palavra',
      'quebrada não pôde ser lida',
    ]);
    // Botões nativos; o texto visível ("Renomear", "Remover") faz parte do nome acessível.
    const actions = within(list).getAllByRole('button');
    expect(actions.map((b) => [b.getAttribute('aria-label'), b.textContent])).toEqual(
      lists.flatMap(({ name }) => {
        const label = name.slice(0, -'.txt'.length);
        return [
          [`Renomear “${label}”`, 'Renomear'],
          [`Remover “${label}”`, 'Remover'],
        ];
      }),
    );
    expect(
      screen.getByRole('button', {
        name: 'Importar lista de termos…',
        description: 'Vai para: Este computador',
      }),
    ).toBeTruthy();
    // A lista de palavras da r32c continua igual, acima das listas.
    expect(removeButton('alfa')).toBeTruthy();
    await click(screen.getByRole('radio', { name: 'Esta pasta' }));
    expect(
      screen.getByRole('button', {
        name: 'Importar lista de termos…',
        description: 'Vai para: Esta pasta',
      }),
    ).toBeTruthy();
    expect(within(section()).queryByRole('list')).toBeNull();
    expect(screen.getByTestId('dictionary-lists-empty').textContent).toBe(
      'Nenhuma lista importada no dicionário desta pasta.',
    );
  });

  test('importar: import(camada), aria-busy enquanto isso, um pedido só, resumo em role=status e o foco fica no botão', async () => {
    const fake = fakeDictionary();
    const pending = Promise.withResolvers<DictionaryEditorImportResult>();
    fake.source.import.mockImplementationOnce(async (layer) => {
      const result = await pending.promise;
      fake.set({ [layer]: ready([], [], [{ name: 'termos-medicos.txt', words: 50_000 }]) });
      return result;
    });
    renderEditor(fake.source);
    await click(screen.getByRole('radio', { name: 'Esta pasta' }));
    const trigger = importButton();
    await click(trigger);
    expect(section().getAttribute('aria-busy')).toBe('true');
    await act(async () => {
      trigger.click();
    });
    expect(fake.source.import).toHaveBeenCalledTimes(1);
    expect(fake.source.import).toHaveBeenLastCalledWith('folder');
    const summary =
      '“termos-medicos” importado: 50.000 palavras, 3 descartadas (lido como ISO-8859-1).';
    await act(async () =>
      pending.resolve({ status: 'imported', name: 'termos-medicos.txt', summary }),
    );
    expect(section().hasAttribute('aria-busy')).toBe(false);
    expect(within(section()).getByRole('status').textContent).toBe(summary);
    expect(button('Remover “termos-medicos”')).toBeTruthy();
    expect(document.activeElement).toBe(trigger);
    expect(screen.queryByTestId('dictionary-lists-error')).toBeNull();
  });

  test('erro de importar em role=alert ligado ao botão; cancelar não muda nada; trocar de camada limpa', async () => {
    const fake = fakeDictionary();
    fake.source.import.mockResolvedValueOnce({
      status: 'failed',
      message: '“enorme.txt” tem 10,1 MB; o limite é 10 MB.',
    });
    renderEditor(fake.source);
    expect(screen.queryByTestId('dictionary-lists-error')).toBeNull();
    await click(importButton());
    const alert = listsAlert();
    expect(alert.getAttribute('role')).toBe('alert');
    expect(alert.textContent).toBe(
      'Não foi possível importar a lista — “enorme.txt” tem 10,1 MB; o limite é 10 MB.',
    );
    expect(alert.querySelector('svg.smd-icon')).not.toBeNull();
    expect(importButton().getAttribute('aria-describedby')?.split(' ')).toContain(alert.id);
    expect(document.activeElement).toBe(importButton());
    expect(listsStatus()).toBe('');
    fake.source.import.mockResolvedValueOnce({ status: 'cancelled' });
    await click(importButton());
    expect(screen.queryByTestId('dictionary-lists-error')).toBeNull();
    expect(listsStatus()).toBe('');
    expect(screen.getByTestId('dictionary-lists-empty')).toBeTruthy();
    fake.source.import.mockResolvedValueOnce({ status: 'failed', message: 'Falha de E/S.' });
    await click(importButton());
    expect(listsAlert().textContent).toBe('Não foi possível importar a lista — Falha de E/S.');
    await click(screen.getByRole('radio', { name: 'Esta pasta' }));
    expect(screen.queryByTestId('dictionary-lists-error')).toBeNull();
  });

  test('"Esta pasta" sem pasta: "Importar…" desabilitado e focável, com o motivo; o clique não chama o serviço', async () => {
    const fake = fakeDictionary({ folder: NO_FOLDER });
    renderEditor(fake.source);
    await click(screen.getByRole('radio', { name: 'Esta pasta' }));
    const trigger = screen.getByRole('button', {
      name: 'Importar lista de termos…',
      description:
        'Vai para: Esta pasta Sem pasta aberta: abra uma pasta para importar uma lista para ela.',
    });
    expect(trigger.getAttribute('aria-disabled')).toBe('true');
    expect(trigger.hasAttribute('disabled')).toBe(false);
    await click(trigger);
    expect(document.activeElement).toBe(trigger);
    expect(fake.source.import).not.toHaveBeenCalled();
    expect(screen.queryByTestId('dictionary-lists-empty')).toBeNull();
    act(() => fake.set({ folder: ready([]) }));
    expect(importButton().hasAttribute('aria-disabled')).toBe(false);
    expect(screen.queryByTestId('dictionary-import-reason')).toBeNull();
  });

  test('renomear: campo rotulado com o nome selecionado; Enter renomeia e o foco volta ao "Renomear" da lista', async () => {
    const fake = fakeDictionary({ global: ready([], [], lists) });
    renderEditor(fake.source);
    await click(button('Renomear “termos-medicos”'));
    const field = screen.getByRole<HTMLInputElement>('textbox', {
      name: 'Novo nome de “termos-medicos”',
      description: 'Enter renomeia; Esc cancela.',
    });
    expect(document.activeElement).toBe(field);
    expect([field.value, field.selectionStart, field.selectionEnd]).toEqual([
      'termos-medicos',
      0,
      'termos-medicos'.length,
    ]);
    fireEvent.change(field, { target: { value: 'clínica' } });
    await act(async () => {
      fireEvent.keyDown(field, { key: 'Enter' });
    });
    expect(fake.source.rename).toHaveBeenCalledWith('global', 'termos-medicos.txt', 'clínica');
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(document.activeElement).toBe(button('Renomear “clínica”'));
    expect(listsStatus()).toBe('Lista “termos-medicos” renomeada para “clínica”.');
  });

  test('renomear: Esc desfaz sem chegar ao diálogo de fora e o foco volta; erro em role=alert, o campo fica inválido e com o foco', async () => {
    const fake = fakeDictionary({ global: ready([], [], lists) });
    renderEditor(fake.source);
    await click(button('Renomear “cardiologia”'));
    const field = screen.getByRole('textbox', { name: 'Novo nome de “cardiologia”' });
    fireEvent.change(field, { target: { value: 'outra' } });
    // `false` = o evento foi cancelado na captura: o Esc do diálogo (Radix) não fecha nada.
    expect(fireEvent.keyDown(field, { key: 'Escape' })).toBe(false);
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(document.activeElement).toBe(button('Renomear “cardiologia”'));
    expect(fake.source.rename).not.toHaveBeenCalled();
    fake.source.rename.mockResolvedValueOnce({
      status: 'failed',
      message: 'Já existe uma lista com esse nome.',
    });
    await click(button('Renomear “cardiologia”'));
    const again = screen.getByRole<HTMLInputElement>('textbox', {
      name: 'Novo nome de “cardiologia”',
    });
    expect(again.value).toBe('cardiologia');
    fireEvent.change(again, { target: { value: 'uma' } });
    await act(async () => {
      fireEvent.keyDown(again, { key: 'Enter' });
    });
    const alert = listsAlert();
    expect(alert.textContent).toBe(
      'Não foi possível renomear “cardiologia” — Já existe uma lista com esse nome.',
    );
    expect(document.activeElement).toBe(again);
    expect(again.value).toBe('uma');
    expect(again.getAttribute('aria-invalid')).toBe('true');
    expect(again.getAttribute('aria-describedby')?.split(' ')).toContain(alert.id);
    fireEvent.keyDown(again, { key: 'Escape' });
    expect(screen.queryByTestId('dictionary-lists-error')).toBeNull();
    expect(document.activeElement).toBe(button('Renomear “cardiologia”'));
  });

  test('remover em 2 passos: "…e suas N palavras?" → "Confirmar remoção"; Esc e "Cancelar" voltam; o foco vai à seguinte, à anterior e a "Importar…"', async () => {
    const fake = fakeDictionary({ global: ready([], [], lists.slice(0, 3)) });
    renderEditor(fake.source);
    await click(button('Remover “cardiologia”'));
    const confirm = screen.getByRole('button', {
      name: 'Confirmar remoção',
      description: 'Remover “cardiologia” e suas 1.200 palavras?',
    });
    expect(document.activeElement).toBe(confirm);
    expect(fake.source.removeList).not.toHaveBeenCalled();
    expect(fireEvent.keyDown(confirm, { key: 'Escape' })).toBe(false);
    expect(document.activeElement).toBe(button('Remover “cardiologia”'));
    await click(button('Remover “uma”'));
    expect(
      screen.getByRole('button', {
        name: 'Confirmar remoção',
        description: 'Remover “uma” e sua única palavra?',
      }),
    ).toBeTruthy();
    await click(button('Cancelar'));
    expect(document.activeElement).toBe(button('Remover “uma”'));
    await click(button('Remover “cardiologia”'));
    await click(button('Confirmar remoção'));
    expect(fake.source.removeList).toHaveBeenLastCalledWith('global', 'cardiologia.txt');
    expect(screen.queryByRole('button', { name: 'Remover “cardiologia”' })).toBeNull();
    expect(document.activeElement).toBe(button('Remover “termos-medicos”'));
    expect(listsStatus()).toBe('Lista “cardiologia” removida do dicionário deste computador.');
    await click(button('Remover “uma”'));
    await click(button('Confirmar remoção'));
    expect(document.activeElement).toBe(button('Remover “termos-medicos”'));
    await click(button('Remover “termos-medicos”'));
    await click(
      screen.getByRole('button', {
        name: 'Confirmar remoção',
        description: 'Remover “termos-medicos” e suas 50.000 palavras?',
      }),
    );
    expect(screen.getByTestId('dictionary-lists-empty').textContent).toBe(
      'Nenhuma lista importada no dicionário deste computador.',
    );
    expect(document.activeElement).toBe(importButton());
    expect(fake.source.removeList).toHaveBeenCalledTimes(3);
  });

  test('renomear uma lista que saiu por fora (NOT_FOUND): o campo fecha, o erro fica e o foco vai à seguinte', async () => {
    const fake = fakeDictionary({ global: ready([], [], lists.slice(0, 3)) });
    fake.source.rename.mockImplementationOnce(async (layer, name) => {
      fake.set({
        [layer]: ready(
          [],
          [],
          lists.slice(0, 3).filter((file) => file.name !== name),
        ),
      });
      return { status: 'failed', message: 'A lista não existe mais.' };
    });
    renderEditor(fake.source);
    await click(button('Renomear “termos-medicos”'));
    const field = screen.getByRole('textbox', { name: 'Novo nome de “termos-medicos”' });
    await act(async () => {
      fireEvent.keyDown(field, { key: 'Enter' });
    });
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(listsAlert().textContent).toBe(
      'Não foi possível renomear “termos-medicos” — A lista não existe mais.',
    );
    expect(document.activeElement).toBe(button('Remover “uma”'));
  });

  test('remover: a falha vai ao role=alert ligado ao "Remover" da lista, que fica, com o foco', async () => {
    const fake = fakeDictionary({ global: ready([], [], lists.slice(0, 2)) });
    fake.source.removeList.mockResolvedValueOnce({
      status: 'failed',
      message: 'Sem permissão para gravar no dicionário.',
    });
    renderEditor(fake.source);
    await click(button('Remover “termos-medicos”'));
    await click(button('Confirmar remoção'));
    const alert = listsAlert();
    expect(alert.textContent).toBe(
      'Não foi possível remover “termos-medicos” — Sem permissão para gravar no dicionário.',
    );
    const remove = button('Remover “termos-medicos”');
    expect(document.activeElement).toBe(remove);
    expect(remove.getAttribute('aria-describedby')).toBe(alert.id);
    expect(listsStatus()).toBe('');
  });

  test('nome de lista (de arquivo da pasta) só como texto', () => {
    const fake = fakeDictionary({
      global: ready([], [], [{ name: '<img src=x onerror=alert(1)>.txt', words: 2 }]),
    });
    const { container } = renderEditor(fake.source);
    expect(container.querySelector('img')).toBeNull();
    expect(button('Remover “<img src=x onerror=alert(1)>”')).toBeTruthy();
  });
});
