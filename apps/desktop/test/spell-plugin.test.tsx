// @vitest-environment jsdom
import '../../../packages/core/test/setup-dom';
import { undo } from '@codemirror/commands';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { runInteract } from '@simplemd/core';
import type { InternalHostContext } from '@simplemd/plugin-api/internal/host';
import * as spellModule from '@simplemd/plugins-internal/spell';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  createHarnessSpell,
  HARNESS_MISSPELLINGS,
  type HarnessSpellControl,
} from '../harness/spell';
import { App } from '../src/app/App';
import {
  defineInternalPlugin,
  SPELL_PLUGIN_ID,
  type InternalAppServices,
  type InternalRegistrationContext,
} from '../src/plugins/internal/define';
import languagetool from '../src/plugins/internal/languagetool';
import spell, {
  SPELL_DICTIONARY_RELOAD_MS,
  SPELL_RELOAD_FAILED,
} from '../src/plugins/internal/spell';
import { parseWordList } from '../src/state/dictionary';
import { INTERNAL_PLUGIN_DEFAULTS } from '../src/state/settings';
import { setup, type Harness } from './helpers';

/**
 * r35c no app: o registro `simplemd.spell` "Ortografia offline" (ligado por padrão, ordem 85,
 * opções da r32c), o caminho completo motor falso → sublinhado → cartão (AC-R35-1, com o erro do
 * harness), o LanguageTool junto (AC-R35-2: o erro aparece uma vez só; D-R35B-01), o menor privilégio
 * (AppSec r35a N3; code-review r35a N3: o plugin recebe só `check`/`suggest`), a recarga do motor só
 * com o corretor ligado (AppSec r35a N4) e as falhas de fora que não limpam a cobertura (AppSec r35b
 * N4).
 */

// Embrulha a fábrica do plugin para ver o que o registro entrega a ele (o comportamento é o real).
vi.mock('@simplemd/plugins-internal/spell', async (importOriginal) => {
  const actual = await importOriginal<typeof spellModule>();
  return { ...actual, createSpellPlugin: vi.fn(actual.createSpellPlugin) };
});

const PT = readFileSync(
  join(__dirname, '../../../packages/plugins-internal/test/fixtures/lt/pt-BR-check.md'),
  'utf8',
);
const CONFIG = '.simplemd/config.json';
const SPELL_OFF = JSON.stringify({ plugins: { internal: { [SPELL_PLUGIN_ID]: false } } });
const FOLDER_PERSONAL = '.simplemd/dictionaries/pessoal.txt';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.mocked(spellModule.createSpellPlugin).mockClear();
});

/**
 * O corretor falso com o erro do harness ("excessão" → "exceção") e as camadas do usuário (o
 * `pessoal.txt` deste computador e o da pasta), no lugar do falso vazio dos testes: o mesmo objeto
 * da plataforma, então o serviço do motor e o registro passam por ele.
 */
function withMisspellings(h: Harness): HarnessSpellControl {
  const fake = createHarnessSpell({
    misspellings: HARNESS_MISSPELLINGS,
    layers: {
      // A pasta já é a ativa da porta quando o app recarrega com `folder` (antes do `handle` no store).
      folder: () => true,
      terms: async (folder) => [
        ...parseWordList(h.dictionaries.text('pessoal.txt') ?? ''),
        ...(folder ? parseWordList(h.port.readText(FOLDER_PERSONAL) ?? '') : []),
      ],
    },
  });
  Object.assign(h.platform.spell, fake.spell);
  return fake.control;
}

const reloads = (control: HarnessSpellControl) => control.calls().filter((c) => c.op === 'reload');
const spellingUnderlines = () => [...document.querySelectorAll('.cm-lintRange-spelling')];
const checks = (control: HarnessSpellControl) =>
  control.calls().filter((c) => c.op === 'check' && c.outcome === 'ok').length;

/** Deixa as respostas já recebidas (microtarefas) e o lint andarem. */
async function drain(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, 0);
  await act(async () => {
    await promise;
  });
}
const row = (h: Harness, id: string) =>
  h.app.plugins.host.getSnapshot().internal.find((r) => r.id === id);

/** Pasta aberta com o corretor falso do harness, a nota aberta no app montado. */
async function withNote(
  files: Record<string, string> = { 'nota.md': PT },
  descriptors = [spell],
): Promise<{ h: Harness; spellCalls: HarnessSpellControl }> {
  const h = await setup(files, { internalDescriptors: descriptors, open: false });
  const spellCalls = withMisspellings(h);
  await h.app.sync.openVault('welcome');
  render(<App app={h.app} />);
  await act(async () => {
    await h.app.sync.openFile('nota.md');
  });
  return { h, spellCalls };
}

/** O cartão do sublinhado em "excessão" (⌘⇧Enter) e o botão `action` dele. */
function cardButton(h: Harness, action: string): HTMLButtonElement | null {
  const view = h.app.plugins.editor.view;
  if (!view) throw new Error('sem editor');
  act(() => {
    view.dispatch({ selection: { anchor: view.state.doc.toString().indexOf('excessão') + 1 } });
    expect(runInteract(view)).toBe(true);
  });
  return document.querySelector<HTMLButtonElement>(
    `[data-testid="problem-card"] [data-action="${action}"]`,
  );
}

describe('descritor', () => {
  test('id, ligado por padrão, ordem 85 (antes do LanguageTool), opções da r32c', () => {
    expect([spell.id, spell.order, spell.defaultEnabled]).toEqual(['simplemd.spell', 85, true]);
    expect(INTERNAL_PLUGIN_DEFAULTS['simplemd.spell']).toBe(true);
    expect(spell.order).toBeLessThan(languagetool.order);
    expect(spell.name).toBe('Ortografia offline');
    expect(spell.description).toBe(
      'Sublinha as palavras fora do dicionário de português do Brasil embutido e do seu dicionário. Funciona sem internet e sem servidor: o texto não sai do computador.',
    );
    const options = spell.options ?? [];
    expect(options.map((o) => [o.key, o.kind, o.label, o.default])).toEqual([
      ['addTo', 'select', 'Adicionar palavras ao', 'global'],
      ['userDictionary', 'dictionary', 'Dicionário', undefined],
    ]);
    // D-R35-5: as mesmas opções do LanguageTool para o dicionário do usuário.
    const lt = new Map((languagetool.options ?? []).map((o) => [o.key, o]));
    for (const option of options) expect(option).toEqual(lt.get(option.key));
  });
});

describe('AC-R35-1: "excessão" sublinhada sem rede e sem LanguageTool; aceitar corrige', () => {
  test('ligado por padrão: um sublinhado do corretor, cartão com troca, 1 desfazer; 0 chamadas ao LT', async () => {
    const { h, spellCalls } = await withNote();
    expect(row(h, SPELL_PLUGIN_ID)?.status).toBe('Ativo');
    await vi.waitFor(() =>
      expect(spellingUnderlines().map((e) => e.textContent)).toEqual(['excessão']),
    );
    // A sugestão chega depois da verificação, uma chamada por vez.
    await vi.waitFor(() =>
      expect(
        spellCalls
          .calls()
          .filter((c) => c.op === 'suggest')
          .map((c) => c.outcome),
      ).toEqual(['ok']),
    );
    const replace = cardButton(h, 'replace');
    expect(replace?.textContent).toBe('Trocar por “exceção”');
    expect(
      document.querySelector<HTMLElement>('[data-testid="problem-card"]')?.dataset.source,
    ).toBe('spell');
    const view = h.app.plugins.editor.view;
    if (!view) throw new Error('sem editor');
    await act(async () => {
      replace?.click();
    });
    expect(view.state.doc.toString()).toBe(PT.replace('excessão', 'exceção'));
    expect(document.querySelector('.cm-announced')?.textContent).toContain(
      'Trocado por “exceção”.',
    );
    act(() => {
      undo(view);
    });
    expect(view.state.doc.toString()).toBe(PT);
    expect(h.lt.calls()).toEqual([]);
    // Só as palavras da prosa foram ao motor, nunca o código.
    expect(
      spellCalls
        .calls()
        .filter((c) => c.op === 'check')
        .every((c) => c.lang === 'pt-BR'),
    ).toBe(true);
  });

  test('Adicionar ao dicionário grava no pessoal.txt deste computador e recarrega o motor', async () => {
    const { h, spellCalls } = await withNote();
    await vi.waitFor(() => expect(spellingUnderlines()).toHaveLength(1));
    await h.app.dictionary.ready();
    const before = reloads(spellCalls).length;
    const add = cardButton(h, 'dictionary');
    expect(add?.textContent).toBe('Adicionar ao dicionário');
    await act(async () => {
      add?.click();
    });
    await vi.waitFor(() => expect(h.dictionaries.text('pessoal.txt')).toBe('excessão\n'));
    await vi.waitFor(() => expect(spellingUnderlines()).toHaveLength(0));
    expect(document.querySelector('.cm-announced')?.textContent).toContain(
      '“excessão” adicionada ao dicionário deste computador.',
    );
    // A recarga do motor sai depois da espera do dicionário, pelo caminho único do app.
    await vi.waitFor(() => expect(reloads(spellCalls).length).toBe(before + 1), {
      timeout: SPELL_DICTIONARY_RELOAD_MS * 8,
    });
    expect(h.app.spellCoverage.languageFor(null)).toBe('pt-BR');
  });

  test('Ignorar vale na sessão: desligar e ligar o corretor não traz o sublinhado de volta', async () => {
    const { h, spellCalls } = await withNote();
    await vi.waitFor(() => expect(spellingUnderlines()).toHaveLength(1));
    const ignore = cardButton(h, 'ignore');
    await act(async () => {
      ignore?.click();
    });
    await vi.waitFor(() => expect(spellingUnderlines()).toHaveLength(0));
    const before = checks(spellCalls);
    for (const enabled of [false, true])
      await act(async () => {
        await h.app.plugins.host.setEnabled(SPELL_PLUGIN_ID, enabled);
      });
    // A ativação nova pergunta de novo (cache novo); a resposta marca "excessão", que fica escondida.
    await vi.waitFor(() => expect(checks(spellCalls)).toBeGreaterThan(before));
    await drain();
    expect(spellingUnderlines()).toHaveLength(0);
    expect(h.dictionaries.names()).toEqual([]);
  });

  test('opções: "Adicionar palavras ao" e a lista "Dicionário" da r32c nas Configurações', async () => {
    const { h } = await withNote();
    act(() => h.app.store.setState({ settingsOpen: true, settingsSection: 'plugins' }));
    fireEvent.click(screen.getByRole('button', { name: 'Opções de “Ortografia offline”' }));
    expect(await screen.findByRole('group', { name: 'Dicionário' })).toBeTruthy();
    const addTo = screen.getByRole('combobox', { name: 'Adicionar palavras ao' });
    expect((addTo as HTMLSelectElement).value).toBe('global');
  });
});

describe('AC-R35-2: com o LanguageTool ligado, o erro aparece uma vez só', () => {
  test('o LT desliga TYPOS e não sublinha "excessão"; o sublinhado é do corretor', async () => {
    const { h } = await withNote({ 'nota.md': PT }, [spell, languagetool]);
    h.lt.mode = { kind: 'recorded', name: 'pt-BR-check' };
    const check = vi.spyOn(h.app.platform.languageTool, 'check');
    await act(async () => {
      await h.app.plugins.host.setEnabled('simplemd.languagetool', true);
    });
    const slow = { timeout: 4_000 };
    await vi.waitFor(
      () => expect(screen.getByTestId('status-lt').textContent).toBe('LanguageTool: 2 problemas'),
      slow,
    );
    await vi.waitFor(() => expect(spellingUnderlines()).toHaveLength(1), slow);
    expect(document.querySelectorAll('.cm-lintRange-grammar')).toHaveLength(2);
    expect(check.mock.calls.at(-1)?.[0].disabledCategories).toEqual(['TYPOS']);
    cardButton(h, 'ignore');
    expect(
      document.querySelector<HTMLElement>('[data-testid="problem-card"]')?.dataset.source,
    ).toBe('spell');
  });

  test('D-R35B-01: LT em inglês → a nota sem lang: fica com ele (o corretor sai); desligar o LT a traz de volta', async () => {
    const { h } = await withNote({ 'nota.md': PT }, [spell, languagetool]);
    await vi.waitFor(() => expect(spellingUnderlines()).toHaveLength(1));
    h.lt.mode = { kind: 'recorded', name: 'pt-BR-check' };
    await act(async () => {
      await h.app.plugins.host.setInternalOption('simplemd.languagetool', 'language', 'en-US');
      await h.app.plugins.host.setEnabled('simplemd.languagetool', true);
    });
    const slow = { timeout: 4_000 };
    await vi.waitFor(
      () => expect(screen.getByTestId('status-lt').textContent).toBe('LanguageTool: 3 problemas'),
      slow,
    );
    await vi.waitFor(() => expect(spellingUnderlines()).toHaveLength(1), slow);
    cardButton(h, 'ignore');
    expect(
      document.querySelector<HTMLElement>('[data-testid="problem-card"]')?.dataset.source,
    ).toBe('languagetool');
    await act(async () => {
      await h.app.plugins.host.setEnabled('simplemd.languagetool', false);
    });
    // O sublinhado do LT sai com ele; o do corretor volta (a nota é dele de novo).
    await vi.waitFor(() => expect(screen.queryByTestId('status-lt')).toBeNull(), slow);
    await vi.waitFor(() => {
      cardButton(h, 'ignore');
      expect(
        document.querySelector<HTMLElement>('[data-testid="problem-card"]')?.dataset.source,
      ).toBe('spell');
    }, slow);
    expect(spellingUnderlines()).toHaveLength(1);
  });
});

describe('menor privilégio (AppSec r35a N3; code-review r35a N3)', () => {
  test('só o registro do simplemd.spell recebe o motor; os outros leem a cobertura e nada mais', async () => {
    const h = await setup({ 'nota.md': '# Nota\n' });
    const seen: InternalRegistrationContext[] = [];
    const probe = (id: `simplemd.${string}`) =>
      defineInternalPlugin({
        id,
        name: id,
        description: '',
        defaultEnabled: false,
        order: 1,
        load: async (ctx) => {
          seen.push(ctx);
          return { default: () => undefined };
        },
      });
    const services = {
      platform: h.platform,
      store: h.app.store,
      registry: h.app.registry,
      catalog: h.app.catalog,
      sync: h.app.sync,
      editor: h.app.plugins.editor,
      dictionary: h.app.dictionary,
      spellCoverage: h.app.spellCoverage,
    } satisfies InternalAppServices;
    const host = {} as InternalHostContext;
    await probe('simplemd.sonda').load({ pluginId: 'simplemd.sonda', host, services });
    await probe(SPELL_PLUGIN_ID).load({ pluginId: SPELL_PLUGIN_ID, host, services });
    const [other, own] = seen;
    expect(other?.spellEngine).toBeUndefined();
    expect(Object.keys(other?.services.spellCoverage ?? {}).sort()).toEqual([
      'languageFor',
      'subscribe',
    ]);
    // @ts-expect-error — os registros só leem a cobertura (AppSec r35a N3).
    const write: unknown = other?.services.spellCoverage.set;
    expect(write).toBeUndefined();
    h.app.spellCoverage.set(['pt-BR']);
    expect(other?.services.spellCoverage.languageFor(null)).toBe('pt-BR');
    expect(own?.spellEngine).toBe(h.app.spellCoverage);
  });

  test('o plugin recebe só check/suggest e a cobertura de leitura; toda recarga passa pelo serviço do app', async () => {
    const h = await setup({ 'nota.md': PT }, { internalDescriptors: [spell], open: false });
    const spellCalls = withMisspellings(h);
    const viaService = vi.spyOn(h.app.spellCoverage, 'reload');
    await h.app.sync.openVault('welcome');
    await vi.waitFor(() => expect(h.app.spellCoverage.languageFor(null)).toBe('pt-BR'));
    const deps = vi.mocked(spellModule.createSpellPlugin).mock.calls.at(-1)?.[1];
    expect(Object.keys(deps?.engine ?? {})).toEqual(['check', 'suggest']);
    expect(Object.keys(deps?.coverage ?? {}).sort()).toEqual(['languageFor', 'subscribe']);
    // A do controlador (pasta aberta) e a da ativação: as duas pelo serviço, nenhuma direto.
    expect(viaService.mock.calls).toEqual([['folder'], ['folder']]);
    expect(reloads(spellCalls).map((c) => c.folder)).toEqual([true, true]);
  });
});

describe('AppSec r35a N4: o motor só recarrega com o corretor ligado na pasta', () => {
  test('desligado no config.json: nenhum spell_reload ao abrir (a base de ~29 MiB nem carrega)', async () => {
    const h = await setup(
      { 'nota.md': PT, [CONFIG]: SPELL_OFF },
      { internalDescriptors: [spell], open: false },
    );
    const spellCalls = withMisspellings(h);
    await h.app.sync.openVault('welcome');
    await vi.waitFor(() => expect(row(h, SPELL_PLUGIN_ID)?.status).toBe('Desativado'));
    expect(spellCalls.calls()).toEqual([]);
    expect(h.app.spellCoverage.languageFor(null)).toBeNull();
  });

  test('de uma pasta com o corretor para outra sem ele: só a camada global sai do motor; ligar lá recarrega', async () => {
    const h = await setup(
      {
        'nota.md': PT,
        [`outra/${CONFIG}`]: SPELL_OFF,
        'outra/nota.md': PT,
        [`terceira/${CONFIG}`]: SPELL_OFF,
      },
      { internalDescriptors: [spell], open: false },
    );
    const spellCalls = withMisspellings(h);
    await h.app.sync.openVault('welcome');
    await vi.waitFor(() => expect(h.app.spellCoverage.languageFor(null)).toBe('pt-BR'));
    expect(reloads(spellCalls).map((c) => c.folder)).toEqual([true, true]);
    h.port.setPickDirectory(() => '/vault/outra');
    await h.app.sync.openVault('shell');
    await vi.waitFor(() => expect(row(h, SPELL_PLUGIN_ID)?.status).toBe('Desativado'));
    // Desligar (o descarte da pasta antiga) tira a cobertura; a recarga sem token tira a camada.
    expect(h.app.spellCoverage.languageFor(null)).toBeNull();
    await vi.waitFor(() =>
      expect(reloads(spellCalls).map((c) => c.folder)).toEqual([true, true, false]),
    );
    // Ligar nesta pasta: a ativação recarrega com a camada dela…
    await h.app.plugins.host.setEnabled(SPELL_PLUGIN_ID, true);
    await vi.waitFor(() => expect(h.app.spellCoverage.languageFor(null)).toBe('pt-BR'));
    expect(reloads(spellCalls).map((c) => c.folder)).toEqual([true, true, false, true]);
    // … e a próxima pasta, de novo sem o corretor, tira essa camada também.
    h.port.setPickDirectory(() => '/vault/terceira');
    await h.app.sync.openVault('shell');
    await vi.waitFor(() =>
      expect(reloads(spellCalls).map((c) => c.folder)).toEqual([true, true, false, true, false]),
    );
  });
});

describe('AppSec r35b N4: recarga que falha', () => {
  async function covered(): Promise<{ h: Harness; spellCalls: HarnessSpellControl }> {
    const h = await setup({ 'nota.md': PT }, { internalDescriptors: [spell], open: false });
    const spellCalls = withMisspellings(h);
    await h.app.sync.openVault('welcome');
    await vi.waitFor(() => expect(h.app.spellCoverage.languageFor(null)).toBe('pt-BR'));
    await h.app.dictionary.ready();
    return { h, spellCalls };
  }
  const spellNotices = (h: Harness) =>
    h.app.store
      .getState()
      .notices.filter((n) => n.text.startsWith('Ortografia offline: '))
      .map((n) => n.text);

  test('CANCELLED de fora (depois das repetições) e VAULT_CLOSED: a cobertura fica, sem aviso', async () => {
    const { h, spellCalls } = await covered();
    const changes = vi.fn();
    h.app.spellCoverage.subscribe(changes);
    for (let i = 0; i < 3; i++) spellCalls.failNext('CANCELLED', 'reload');
    const before = reloads(spellCalls).length;
    await h.app.dictionary.add('primeira', 'global');
    await vi.waitFor(() => expect(reloads(spellCalls).length).toBe(before + 3), {
      timeout: SPELL_DICTIONARY_RELOAD_MS * 8,
    });
    spellCalls.failNext('VAULT_CLOSED', 'reload');
    await h.app.dictionary.add('segunda', 'global');
    await vi.waitFor(() => expect(reloads(spellCalls).length).toBe(before + 4), {
      timeout: SPELL_DICTIONARY_RELOAD_MS * 8,
    });
    await drain();
    expect(h.app.spellCoverage.languageFor(null)).toBe('pt-BR');
    expect(changes).not.toHaveBeenCalled();
    expect(spellNotices(h)).toEqual([]);
  });

  test('falha do motor (IO): sem cobertura e um aviso só, também na falha seguinte', async () => {
    const { h, spellCalls } = await covered();
    spellCalls.failNext('IO', 'reload');
    await h.app.dictionary.add('primeira', 'global');
    await vi.waitFor(() => expect(h.app.spellCoverage.languageFor(null)).toBeNull(), {
      timeout: SPELL_DICTIONARY_RELOAD_MS * 8,
    });
    expect(spellNotices(h)).toEqual([`Ortografia offline: ${SPELL_RELOAD_FAILED}`]);
    spellCalls.failNext('IO', 'reload');
    const before = reloads(spellCalls).length;
    await h.app.dictionary.add('segunda', 'global');
    await vi.waitFor(() => expect(reloads(spellCalls).length).toBe(before + 1), {
      timeout: SPELL_DICTIONARY_RELOAD_MS * 8,
    });
    expect(spellNotices(h)).toHaveLength(1);
    // A próxima recarga boa volta a cobrir.
    await h.app.dictionary.add('terceira', 'global');
    await vi.waitFor(() => expect(h.app.spellCoverage.languageFor(null)).toBe('pt-BR'), {
      timeout: SPELL_DICTIONARY_RELOAD_MS * 8,
    });
  });
});
