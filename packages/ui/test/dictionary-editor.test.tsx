import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  DICTIONARY_LIST_MAX,
  DictionaryEditor,
  type DictionaryEditorLayer,
  type DictionaryEditorLayerView,
  type DictionaryEditorRemoveResult,
  type DictionaryEditorSnapshot,
  type DictionaryEditorSource,
} from '../src/plugins/DictionaryEditor';
import { PluginOptions } from '../src/plugins/PluginOptions';

/**
 * r32c — lista do dicionário (AC-R32-1 remover, AC-R32-4): nomes acessíveis, camada, busca, teto de
 * 100, foco depois de remover, estados (carregando, sem pasta, vazio, erro) e a opção `dictionary`
 * no `PluginOptions`. O serviço é um falso com a forma do `app.dictionary` (r32b).
 */
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const ready = (
  terms: readonly string[],
  warnings: DictionaryEditorLayerView['warnings'] = [],
): DictionaryEditorLayerView => ({ status: 'ready', terms, warnings });

/** Falso do serviço: snapshot imutável; `remove` tira a palavra da camada e avisa os assinantes. */
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
    act(() => fake.set({ folder: { status: 'none', terms: [], warnings: [] } }));
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
});

describe('estados e entrada não confiável', () => {
  test('carregando; erro de leitura com o aviso e a lista anterior; avisos viram frase', () => {
    const fake = fakeDictionary({ global: { status: 'loading', terms: [], warnings: [] } });
    renderEditor(fake.source);
    expect(screen.getByText('Carregando o dicionário…')).toBeTruthy();
    expect(screen.queryByRole('list')).toBeNull();
    const read = {
      id: 'global:read',
      text: 'não foi possível ler o dicionário deste computador (IO).',
    };
    act(() => fake.set({ global: { status: 'error', terms: ['alfa'], warnings: [read] } }));
    expect(screen.getByTestId('dictionary-warning').textContent).toBe(
      'Não foi possível ler o dicionário deste computador (IO).',
    );
    expect(removeButton('alfa')).toBeTruthy();
    // Sem palavras da leitura anterior: só o aviso, nunca "Nenhuma palavra…".
    act(() => fake.set({ global: { status: 'error', terms: [], warnings: [read] } }));
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
