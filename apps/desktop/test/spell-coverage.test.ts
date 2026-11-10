// r35a (design-r35 §1; AC-R35A-1/2): a cobertura de línguas do corretor offline (`languageFor`, que
// o LanguageTool lê na r35b) e o caminho único do app para `spell_reload` — a recarga mais nova do
// app vence e o `CANCELLED` de fora repete —, chamado a cada pasta aberta e na volta às boas-vindas,
// sobre o corretor falso do harness (as regras do Rust).
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createHarnessSpell, type SpellFakeCall } from '../harness/spell';
import type { SpellReloaded } from '../src/platform/types';
import {
  DEFAULT_SPELL_LANGUAGE,
  SPELL_RELOAD_RETRIES,
  SpellCoverageService,
  coveredLanguage,
} from '../src/state/spell-coverage';
import { setup } from './helpers';

const RELOADED: SpellReloaded = { langs: ['pt-BR'], words: 0, pairs: 0, skipped: 0 };
const reloads = (calls: readonly SpellFakeCall[]) =>
  calls.filter((c) => c.op === 'reload').map((c) => c.outcome);

describe('languageFor (AC-R35A-2)', () => {
  test('sem lang → pt-BR; a igual sem diferença de caixa; o primário com uma língua; senão null', () => {
    const coverage = new SpellCoverageService(createHarnessSpell().spell);
    coverage.set(['pt-BR']);
    const cases: Array<[string | null, string | null]> = [
      [null, 'pt-BR'],
      ['pt-BR', 'pt-BR'],
      ['pt-br', 'pt-BR'],
      ['PT-BR', 'pt-BR'],
      ['pt', 'pt-BR'],
      ['PT', 'pt-BR'],
      ['pt-PT', null],
      ['pt-BR-x-abnt', null],
      ['en-US', null],
      ['en', null],
      ['', null],
    ];
    for (const [fmLang, expected] of cases)
      expect(coverage.languageFor(fmLang), JSON.stringify(fmLang)).toBe(expected);
    expect(DEFAULT_SPELL_LANGUAGE).toBe('pt-BR');
  });

  test('sem cobertura (antes do set e depois do clear) → null para qualquer lang', () => {
    const coverage = new SpellCoverageService(createHarnessSpell().spell);
    for (const fmLang of [null, 'pt-BR', 'pt']) expect(coverage.languageFor(fmLang)).toBeNull();
    coverage.set(['pt-BR']);
    coverage.clear();
    for (const fmLang of [null, 'pt-BR', 'pt']) expect(coverage.languageFor(fmLang)).toBeNull();
  });

  test('o primário com duas línguas cobertas não decide; sem lang vale pt-BR só se coberto', () => {
    expect(coveredLanguage(['pt-BR', 'pt-PT'], 'pt')).toBeNull();
    expect(coveredLanguage(['pt-BR', 'pt-PT'], 'pt-PT')).toBe('pt-PT');
    expect(coveredLanguage(['pt-BR', 'pt-PT'], null)).toBe('pt-BR');
    expect(coveredLanguage(['en-US'], null)).toBeNull();
    expect(coveredLanguage(['en-US'], 'en')).toBe('en-US');
    expect(coveredLanguage([], 'pt-BR')).toBeNull();
  });
});

describe('cobertura: set, clear e subscribe', () => {
  test('avisa só quando muda; clear tira a cobertura; a assinatura cancelada não ouve mais', () => {
    const coverage = new SpellCoverageService(createHarnessSpell().spell);
    const changes = vi.fn();
    const stop = coverage.subscribe(changes);
    coverage.set(['pt-BR']);
    coverage.set(['pt-BR']);
    coverage.set(['pt-BR', 'pt-BR']);
    expect(changes).toHaveBeenCalledTimes(1);
    coverage.clear();
    coverage.clear();
    expect(changes).toHaveBeenCalledTimes(2);
    stop();
    coverage.set(['pt-BR']);
    expect(changes).toHaveBeenCalledTimes(2);
    expect(coverage.languageFor(null)).toBe('pt-BR');
  });
});

describe('reload: o caminho único do app para spell_reload', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test('o pedido sai na hora e a cobertura não muda', async () => {
    const reload = vi.fn(async () => RELOADED);
    const coverage = new SpellCoverageService({
      check: async () => [],
      suggest: async () => [],
      reload,
    });
    const pending = coverage.reload();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(await pending).toEqual(RELOADED);
    expect(coverage.languageFor(null)).toBeNull();
  });

  test('a recarga mais nova do app vence: a vencida recebe o resultado dela, sem tentar de novo', async () => {
    const { spell, control } = createHarnessSpell();
    control.delayMs = 100;
    const coverage = new SpellCoverageService(spell);
    const older = coverage.reload();
    const newer = coverage.reload();
    await vi.advanceTimersByTimeAsync(100);
    const [a, b] = await Promise.all([older, newer]);
    expect(a).toEqual(RELOADED);
    expect(a).toBe(b);
    expect(reloads(control.calls())).toEqual(['CANCELLED', 'ok']);
  });

  test('CANCELLED de fora (um plugin recarregou): repete, até SPELL_RELOAD_RETRIES vezes', async () => {
    const { spell, control } = createHarnessSpell();
    const coverage = new SpellCoverageService(spell);
    control.failNext('CANCELLED', 'reload');
    expect(await coverage.reload()).toEqual(RELOADED);
    expect(reloads(control.calls())).toEqual(['CANCELLED', 'ok']);
    control.reset();
    for (let i = 0; i <= SPELL_RELOAD_RETRIES; i++) control.failNext('CANCELLED', 'reload');
    await expect(coverage.reload()).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(reloads(control.calls())).toEqual(['CANCELLED', 'CANCELLED', 'CANCELLED']);
  });

  test('outro erro não repete: rejeita com o código da porta', async () => {
    const { spell, control } = createHarnessSpell();
    const coverage = new SpellCoverageService(spell);
    for (const code of ['VAULT_CLOSED', 'NO_VAULT', 'SPELL_UNAVAILABLE', 'IO'] as const) {
      control.reset();
      control.failNext(code, 'reload');
      await expect(coverage.reload()).rejects.toMatchObject({ code });
      expect(reloads(control.calls())).toEqual([code]);
    }
  });
});

describe('app: spell_reload a cada pasta aberta e na volta às boas-vindas', () => {
  test('abrir e trocar de pasta recarregam; o CANCELLED de fora repete; nada de check sem o plugin', async () => {
    const h = await setup({ 'a.md': '# A\n' });
    await vi.waitFor(() => expect(reloads(h.spell.calls())).toEqual(['ok']));
    h.spell.failNext('CANCELLED', 'reload');
    await h.app.sync.openVault('shell');
    await vi.waitFor(() => expect(reloads(h.spell.calls())).toEqual(['ok', 'CANCELLED', 'ok']));
    expect(h.spell.calls().filter((c) => c.op !== 'reload')).toEqual([]);
    expect(h.app.spellCoverage.languageFor(null)).toBeNull();
  });

  test('a pasta que não abre das boas-vindas: recarrega também na volta', async () => {
    const h = await setup({ 'a.md': '# A\n' }, { open: false });
    expect(h.spell.calls()).toEqual([]);
    h.port.fault({ op: 'readDir', error: 'PERMISSION_DENIED' });
    await h.app.sync.openVault('welcome');
    expect(h.app.store.getState().welcomeError).toEqual({ kind: 'denied' });
    await vi.waitFor(() => expect(reloads(h.spell.calls())).toHaveLength(2));
    expect(reloads(h.spell.calls()).at(-1)).toBe('ok');
  });

  test('uma recarga que falha não chega à tela', async () => {
    const h = await setup({ 'a.md': '# A\n' }, { open: false });
    h.spell.failNext('SPELL_UNAVAILABLE', 'reload');
    await h.app.sync.openVault('welcome');
    await vi.waitFor(() => expect(reloads(h.spell.calls())).toEqual(['SPELL_UNAVAILABLE']));
    expect(h.app.store.getState().vaultStatus).toBe('open');
    expect(JSON.stringify(h.app.store.getState().notices)).not.toMatch(/corretor|pt-BR/);
  });
});
