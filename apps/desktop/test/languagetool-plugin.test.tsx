// @vitest-environment jsdom
import '../../../packages/core/test/setup-dom';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { runInteract } from '@simplemd/core';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { App } from '../src/app/App';
import { LANGUAGETOOL_DOCS_URL } from '../src/app/status-bar';
import { internalPluginDescriptors } from '../src/plugins/internal/index';
import languagetool, { LANGUAGETOOL_ENABLED_NOTE } from '../src/plugins/internal/languagetool';
import { INTERNAL_PLUGIN_DEFAULTS } from '../src/state/settings';
import { setup, type Harness } from './helpers';

/**
 * r7 S8 (I-8) no app: registro `simplemd.languagetool` (desligado por padrão, opções, linha de
 * motivo STR-170 + "Como instalar"), AC-I8.1 (desligado → 0 chamadas ao transporte em 60 s;
 * ligado → explicação) e o caminho completo transporte → diagnósticos → barra de status. r32b: o
 * dicionário do app (AC-R32-1 adicionar, AC-R32-2, AC-R32-3 migração) com o LanguageTool falso.
 * r32c: a lista "Dicionário" das opções (AC-R32-1 remover, com o plugin desligado e D-R32-6) e o
 * interruptor durante a leitura das opções da pasta (a ativação espera o data.json e migra).
 */
const PT = readFileSync(
  join(__dirname, '../../../packages/plugins-internal/test/fixtures/lt/pt-BR-check.md'),
  'utf8',
);

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('descritor', () => {
  test('id, ordem, desligado por padrão, opções da arch-ux §3.3.1', () => {
    expect([languagetool.id, languagetool.order, languagetool.defaultEnabled]).toEqual([
      'simplemd.languagetool',
      90,
      false,
    ]);
    expect(INTERNAL_PLUGIN_DEFAULTS['simplemd.languagetool']).toBe(false);
    expect(languagetool.name).toBe('Ortografia e gramática (LanguageTool)');
    const options = languagetool.options ?? [];
    expect(options.map((o) => [o.key, o.kind, o.label, o.default])).toEqual([
      ['mode', 'select', 'Verificação', 'auto'],
      ['language', 'select', 'Idioma padrão', 'pt-BR'],
      ['addTo', 'select', 'Adicionar palavras ao', 'global'],
      ['disabledRules', 'list', 'Regras desativadas', []],
      ['userDictionary', 'dictionary', 'Dicionário', undefined],
    ]);
    // r32c: a lista das camadas, sem valor no data.json (o gerenciador usa o serviço do app).
    expect(options[4]?.help).toBe(
      'Palavras que não são sublinhadas como erro de ortografia. Remover tira a palavra de todos os arquivos .txt da camada; o sublinhado volta na próxima verificação.',
    );
    // r32b (D-R32-4): "Este computador" por padrão; sai a linha `info` do dicionário do data.json.
    expect(options[2]?.choices).toEqual([
      { value: 'global', label: 'Este computador' },
      { value: 'folder', label: 'Esta pasta' },
    ]);
    expect(options[2]?.help).toBe(
      'Onde “Adicionar ao dicionário” grava a palavra. Este computador: vale em todas as pastas abertas aqui. Esta pasta: fica em .simplemd/dictionaries/pessoal.txt e viaja com a pasta.',
    );
    expect(options[3]?.removeLabel?.('RULE_X')).toBe('Reativar RULE_X');
    expect(options[3]?.emptyText).toBe('Nenhuma regra desativada.');
    expect(options[1]?.choices?.map((c) => c.value)).toEqual([
      'pt-BR',
      'pt-PT',
      'en-US',
      'en-GB',
      'es',
      'fr',
      'de',
      'auto',
    ]);
  });

  test('linha de motivo STR-170 + "Como instalar" abre a documentação pelo opener', async () => {
    const h = await setup({ 'nota.md': '# Nota\n' }, { internalDescriptors: [languagetool] });
    await h.app.plugins.host.setEnabled('simplemd.languagetool', true);
    await vi.waitFor(() =>
      expect(
        h.app.plugins.host.getSnapshot().internal.find((r) => r.id === 'simplemd.languagetool')
          ?.enabledNote?.text,
      ).toBe(LANGUAGETOOL_ENABLED_NOTE),
    );
    expect(LANGUAGETOOL_ENABLED_NOTE).toBe(
      'Precisa de um servidor LanguageTool rodando neste computador em http://localhost:8081. O texto vai só para esse servidor local.',
    );
    const row = h.app.plugins.host
      .getSnapshot()
      .internal.find((r) => r.id === 'simplemd.languagetool');
    expect(row?.enabledNote?.action?.label).toBe('Como instalar');
    row?.enabledNote?.action?.run();
    await vi.waitFor(() =>
      expect(h.opener.calls().map((c) => c.url)).toEqual([LANGUAGETOOL_DOCS_URL]),
    );
  });
});

describe('AC-I8.1', () => {
  test('desligado (padrão): 0 chamadas ao transporte do LT em 60 s de uso', async () => {
    vi.useFakeTimers();
    const h = await setup({ 'nota.md': PT }, { internalDescriptors: internalPluginDescriptors() });
    render(<App app={h.app} />);
    await act(async () => {
      await h.app.sync.openFile('nota.md');
    });
    const id = h.app.store.getState().activeId;
    if (!id) throw new Error('sem aba');
    for (let s = 0; s < 60; s++) {
      h.type(id, ' palavra');
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
      });
    }
    expect(h.app.settings.internalPluginEnabled('simplemd.languagetool')).toBe(false);
    expect(h.lt.calls()).toEqual([]);
    expect(screen.queryByTestId('status-lt')).toBeNull();
    // 60 rodadas de render com todos os descritores: folga para o CI/máquina carregada.
  }, 30_000);

  test('ligado: sonda, verificação da nota aberta e "LanguageTool: 3 problemas" na barra', async () => {
    const h = await setup({ 'nota.md': PT }, { internalDescriptors: [languagetool] });
    h.lt.mode = { kind: 'recorded', name: 'pt-BR-check' };
    render(<App app={h.app} />);
    await act(async () => {
      await h.app.sync.openFile('nota.md');
    });
    await act(async () => {
      await h.app.plugins.host.setEnabled('simplemd.languagetool', true);
    });
    await vi.waitFor(() =>
      expect(screen.getByTestId('status-lt').textContent).toBe('LanguageTool: 3 problemas'),
    );
    const ops = h.lt.calls().map((c) => c.op);
    expect(ops.slice(0, 2)).toEqual(['languages', 'check']);
    expect(h.lt.calls()[1]?.language).toBe('pt-BR');
    await vi.waitFor(() =>
      expect(document.querySelectorAll('.cm-lintRange-spelling').length).toBe(1),
    );
    expect(document.querySelectorAll('.cm-lintRange-grammar').length).toBe(2);
    // Desligar tira o item da barra e para as chamadas.
    await act(async () => {
      await h.app.plugins.host.setEnabled('simplemd.languagetool', false);
    });
    const after = h.lt.calls().length;
    expect(screen.queryByTestId('status-lt')).toBeNull();
    expect(document.querySelectorAll('.cm-lintRange-spelling').length).toBe(0);
    expect(h.lt.calls().length).toBe(after);
  });
});

describe('paleta (D-R7-M05, CR-PAL-D01)', () => {
  test('"Verificar ortografia e gramática agora" registrado 1× por ativação; 0 avisos "repetido"', async () => {
    const warn = vi.spyOn(console, 'warn');
    const h = await setup({ 'nota.md': PT }, { internalDescriptors: [languagetool] });
    h.lt.mode = { kind: 'recorded', name: 'pt-BR-check' };
    render(<App app={h.app} />);
    await act(async () => {
      await h.app.sync.openFile('nota.md');
    });
    const id = 'simplemd.languagetool:check-now';
    for (let round = 0; round < 2; round++) {
      await act(async () => {
        await h.app.plugins.host.setEnabled('simplemd.languagetool', true);
      });
      await vi.waitFor(() =>
        expect(h.app.plugins.commands.get(id)?.title).toBe(
          'Verificar ortografia e gramática agora',
        ),
      );
      await vi.waitFor(() =>
        expect(screen.getByTestId('status-lt').textContent).toBe('LanguageTool: 3 problemas'),
      );
      const checks = h.lt.calls().filter((c) => c.op === 'check').length;
      await act(async () => {
        h.app.plugins.commands.get(id)?.run();
      });
      await vi.waitFor(() =>
        expect(h.lt.calls().filter((c) => c.op === 'check').length).toBe(checks + 1),
      );
      await act(async () => {
        await h.app.plugins.host.setEnabled('simplemd.languagetool', false);
      });
      expect(h.app.plugins.commands.get(id)).toBeUndefined();
    }
    const repeated = warn.mock.calls.filter((args) => String(args[0]).includes('repetido'));
    expect(repeated).toEqual([]);
  });
});

const DATA = '.simplemd/plugins/simplemd.languagetool/data.json';
const FOLDER_PERSONAL = '.simplemd/dictionaries/pessoal.txt';
const spellingUnderlines = () => document.querySelectorAll('.cm-lintRange-spelling').length;
const statusText = () => screen.getByTestId('status-lt').textContent;
const checks = (h: Harness) => h.lt.calls().filter((c) => c.op === 'check').length;

/** Nota aberta e LanguageTool ligado (respostas gravadas): 3 problemas, 1 de ortografia. */
async function withChecked(files: Record<string, string> = {}): Promise<Harness> {
  const h = await setup({ 'nota.md': PT, ...files }, { internalDescriptors: [languagetool] });
  h.lt.mode = { kind: 'recorded', name: 'pt-BR-check' };
  render(<App app={h.app} />);
  await act(async () => {
    await h.app.sync.openFile('nota.md');
  });
  await act(async () => {
    await h.app.plugins.host.setEnabled('simplemd.languagetool', true);
  });
  await vi.waitFor(() => expect(statusText()).toBe('LanguageTool: 3 problemas'));
  await vi.waitFor(() => expect(spellingUnderlines()).toBe(1));
  return h;
}

/** Cartão do problema em "excessão" (⌘⇧Enter) → "Adicionar ao dicionário". */
async function addFromCard(h: Harness): Promise<void> {
  const view = h.app.plugins.editor.view;
  if (!view) throw new Error('sem editor');
  act(() => {
    view.dispatch({ selection: { anchor: view.state.doc.toString().indexOf('excessão') + 1 } });
    expect(runInteract(view)).toBe(true);
  });
  const button = document.querySelector<HTMLButtonElement>(
    '[data-testid="problem-card"] [data-action="dictionary"]',
  );
  expect(button?.textContent).toBe('Adicionar ao dicionário');
  await act(async () => {
    button?.click();
  });
}

describe('r32b: dicionário do app (camadas deste computador e desta pasta)', () => {
  test('AC-R32-1: o cartão grava no pessoal.txt deste computador; o sublinhado sai e a palavra vale em outra pasta', async () => {
    const h = await withChecked({ 'outra/nota.md': PT });
    await addFromCard(h);
    await vi.waitFor(() => expect(h.dictionaries.text('pessoal.txt')).toBe('excessão\n'));
    await vi.waitFor(() => expect(spellingUnderlines()).toBe(0));
    expect(statusText()).toBe('LanguageTool: 2 problemas');
    expect(document.querySelector('.cm-announced')?.textContent).toContain(
      '“excessão” adicionada ao dicionário deste computador.',
    );
    expect(h.port.readText(FOLDER_PERSONAL)).toBeNull();
    // Outra pasta, a mesma frase: sem sublinhado de ortografia (a camada global vale nela).
    h.port.setPickDirectory(() => '/vault/outra');
    await act(async () => {
      await h.app.sync.openVault('shell');
    });
    await act(async () => {
      await h.app.sync.openFile('nota.md');
    });
    await act(async () => {
      await h.app.plugins.host.setEnabled('simplemd.languagetool', true);
    });
    expect(h.app.store.getState().handle?.root).toBe('/vault/outra');
    await vi.waitFor(() => expect(statusText()).toBe('LanguageTool: 2 problemas'));
    await vi.waitFor(() =>
      expect(document.querySelectorAll('.cm-lintRange-grammar').length).toBe(2),
    );
    expect(spellingUnderlines()).toBe(0);
  });

  test('"Adicionar palavras ao" = Esta pasta: grava .simplemd/dictionaries/pessoal.txt (D-R32-4)', async () => {
    const h = await withChecked();
    const before = checks(h);
    await act(async () => {
      await h.app.plugins.host.setInternalOption('simplemd.languagetool', 'addTo', 'folder');
    });
    // A opção mudou: o plugin reverifica o trecho visível antes de o cartão abrir.
    await vi.waitFor(() => expect(checks(h)).toBe(before + 1));
    await vi.waitFor(() => expect(statusText()).toBe('LanguageTool: 3 problemas'));
    await addFromCard(h);
    await vi.waitFor(() => expect(h.port.readText(FOLDER_PERSONAL)).toBe('excessão\n'));
    await vi.waitFor(() => expect(spellingUnderlines()).toBe(0));
    expect(h.dictionaries.names()).toEqual([]);
    expect(JSON.parse(h.port.readText(DATA) ?? '{}')).toEqual({ addTo: 'folder' });
    expect(document.querySelector('.cm-announced')?.textContent).toContain(
      '“excessão” adicionada ao dicionário desta pasta.',
    );
  });

  test('AC-R32-2: um `.txt` novo em .simplemd/dictionaries tira o sublinhado sem reabrir nem pedir de novo', async () => {
    const h = await withChecked();
    const before = checks(h);
    h.port.externalWrite('.simplemd/dictionaries/clinica.txt', '# termos da clínica\nexcessão\n');
    await vi.waitFor(() => expect(spellingUnderlines()).toBe(0));
    expect(statusText()).toBe('LanguageTool: 2 problemas');
    expect(checks(h)).toBe(before);
  });

  /**
   * Pasta com o `dictionary` antigo no `data.json`. Liga o plugin depois de as opções serem lidas,
   * como quem liga pelas Configurações (ligar no meio da leitura: teste da r32c, abaixo).
   */
  async function withLegacy(words: readonly string[]): Promise<Harness> {
    const h = await setup(
      { 'nota.md': '# Nota\n', [DATA]: JSON.stringify({ mode: 'manual', dictionary: words }) },
      { internalDescriptors: [languagetool] },
    );
    await vi.waitFor(() =>
      expect(h.app.plugins.host.internalOptions('simplemd.languagetool')?.values.mode).toBe(
        'manual',
      ),
    );
    return h;
  }

  test('AC-R32-3: o dicionário do data.json vai uma vez para o pessoal.txt da pasta e só então sai; religar: 0 gravações', async () => {
    const h = await withLegacy(['excessão', 'Outra']);
    await h.app.plugins.host.setEnabled('simplemd.languagetool', true);
    await vi.waitFor(() =>
      expect(JSON.parse(h.port.readText(DATA) ?? '{}')).toEqual({ mode: 'manual' }),
    );
    expect(h.port.readText(FOLDER_PERSONAL)).toBe('excessão\nOutra\n');
    expect(h.app.dictionary.known('Excessão')).toBe(true);
    expect(h.dictionaries.names()).toEqual([]);
    const writes = () =>
      h.port
        .calls()
        .filter((c) => c.op === 'writeFile' && /\/(pessoal\.txt|data\.json)$/.test(c.abs)).length;
    const before = writes();
    await h.app.plugins.host.setEnabled('simplemd.languagetool', false);
    await h.app.plugins.host.setEnabled('simplemd.languagetool', true);
    await vi.waitFor(() =>
      expect(
        h.app.plugins.host.getSnapshot().internal.find((r) => r.id === 'simplemd.languagetool')
          ?.status,
      ).toBe('Ativo'),
    );
    // Sem a chave, a ativação nem chama o dicionário: só as cargas dele, já terminadas.
    await h.app.dictionary.ready();
    expect(writes()).toBe(before);
  });

  test('AC-R32-3: a gravação do pessoal.txt falha → a chave fica no data.json, com aviso', async () => {
    const h = await withLegacy(['excessão']);
    h.port.failNext('writeFile', 'IO', FOLDER_PERSONAL);
    await h.app.plugins.host.setEnabled('simplemd.languagetool', true);
    await vi.waitFor(() =>
      expect(
        h.app.store
          .getState()
          .notices.some((n) =>
            n.text.endsWith(
              'não foi possível gravar o dicionário antigo em .simplemd/dictionaries/pessoal.txt — Falha injetada (IO).',
            ),
          ),
      ).toBe(true),
    );
    expect(JSON.parse(h.port.readText(DATA) ?? '{}')).toEqual({
      mode: 'manual',
      dictionary: ['excessão'],
    });
    expect(h.port.readText(FOLDER_PERSONAL)).toBeNull();
    expect(h.app.dictionary.known('excessão')).toBe(false);
  });
});

const OPTIONS_BUTTON = 'Opções de “Ortografia e gramática (LanguageTool)”';

/** Configurações → Plugins → "Opções" do LanguageTool: o grupo "Dicionário" (r32c). */
async function openDictionary(h: Harness): Promise<HTMLElement> {
  act(() => h.app.store.setState({ settingsOpen: true, settingsSection: 'plugins' }));
  fireEvent.click(screen.getByRole('button', { name: OPTIONS_BUTTON }));
  return screen.findByRole('group', { name: 'Dicionário' });
}

/** Remover pelo teclado: o botão focado é acionado (Enter/Espaço num `<button>` nativo). */
async function pressRemove(word: string): Promise<void> {
  const button = await screen.findByRole('button', { name: `Remover “${word}”` });
  button.focus();
  await act(async () => {
    button.click();
  });
}

describe('r32c: lista "Dicionário" nas opções do LanguageTool', () => {
  test('AC-R32-1 (remover): a palavra sai do pessoal.txt deste computador e volta a ser sublinhada na verificação seguinte', async () => {
    const h = await withChecked();
    await addFromCard(h);
    await vi.waitFor(() => expect(h.dictionaries.text('pessoal.txt')).toBe('excessão\n'));
    await vi.waitFor(() => expect(spellingUnderlines()).toBe(0));
    await openDictionary(h);
    await pressRemove('excessão');
    await vi.waitFor(() => expect(h.dictionaries.text('pessoal.txt')).toBe(''));
    expect(h.app.dictionary.known('excessão')).toBe(false);
    expect(screen.getByTestId('dictionary-live').textContent).toBe(
      '“excessão” removida do dicionário deste computador.',
    );
    // A lista esvaziou: o foco fica no diálogo, na busca.
    expect(document.activeElement).toBe(screen.getByRole('searchbox', { name: 'Buscar' }));
    // D-R32-6: o sublinhado volta na verificação seguinte, não na hora.
    expect(spellingUnderlines()).toBe(0);
    act(() => h.app.store.setState({ settingsOpen: false }));
    const before = checks(h);
    await act(async () => {
      h.app.plugins.commands.get('simplemd.languagetool:check-now')?.run();
    });
    await vi.waitFor(() => expect(checks(h)).toBe(before + 1));
    await vi.waitFor(() => expect(spellingUnderlines()).toBe(1));
    expect(statusText()).toBe('LanguageTool: 3 problemas');
  });

  test('com o plugin desligado: lista as duas camadas e remover tira a palavra de todos os .txt da camada (D-R32-6)', async () => {
    const h = await setup(
      {
        'nota.md': '# Nota\n',
        [FOLDER_PERSONAL]: 'excessão\nclínica\n',
        '.simplemd/dictionaries/termos.txt': '# termos da clínica\nexcessão\n',
      },
      { internalDescriptors: [languagetool] },
    );
    h.dictionaries.put('pessoal.txt', 'computador\n');
    render(<App app={h.app} />);
    await openDictionary(h);
    expect(await screen.findByRole('button', { name: 'Remover “computador”' })).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: 'Esta pasta' }));
    const list = await screen.findByRole('list', { name: 'Palavras do dicionário desta pasta' });
    expect([...list.querySelectorAll('.smd-dict-word')].map((w) => w.textContent)).toEqual([
      'excessão',
      'clínica',
    ]);
    await pressRemove('excessão');
    await vi.waitFor(() => expect(h.port.readText(FOLDER_PERSONAL)).toBe('clínica\n'));
    expect(h.port.readText('.simplemd/dictionaries/termos.txt')).toBe('# termos da clínica\n');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Remover “clínica”' }));
    expect(h.app.dictionary.known('excessão')).toBe(false);
    expect(h.dictionaries.text('pessoal.txt')).toBe('computador\n');
    expect(h.app.settings.internalPluginEnabled('simplemd.languagetool')).toBe(false);
    expect(h.lt.calls()).toEqual([]);
  });

  test('ligar enquanto as opções da pasta ainda são lidas: a mesma ativação vê o data.json e migra', async () => {
    const h = await setup(
      {
        'nota.md': '# Nota\n',
        [DATA]: JSON.stringify({ mode: 'manual', dictionary: ['excessão'] }),
      },
      { internalDescriptors: [languagetool], open: false },
    );
    // A leitura do data.json demora (pasta sincronizada lenta): o interruptor chega antes do fim.
    h.port.fault({ op: 'readFile', path: DATA, delayMs: 50, once: true });
    await h.app.sync.openVault('welcome');
    const host = h.app.plugins.host;
    expect(host.internalOptions('simplemd.languagetool')?.values.mode).toBe('auto');
    await host.setEnabled('simplemd.languagetool', true);
    expect(host.internalOptions('simplemd.languagetool')?.values.mode).toBe('manual');
    await vi.waitFor(() =>
      expect(JSON.parse(h.port.readText(DATA) ?? '{}')).toEqual({ mode: 'manual' }),
    );
    expect(h.port.readText(FOLDER_PERSONAL)).toBe('excessão\n');
    expect(h.app.dictionary.known('excessão')).toBe(true);
  });
});
