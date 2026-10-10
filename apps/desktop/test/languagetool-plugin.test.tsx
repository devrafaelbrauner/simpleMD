// @vitest-environment jsdom
import '../../../packages/core/test/setup-dom';
import { act, cleanup, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { App } from '../src/app/App';
import { LANGUAGETOOL_DOCS_URL } from '../src/app/status-bar';
import { internalPluginDescriptors } from '../src/plugins/internal/index';
import languagetool, { LANGUAGETOOL_ENABLED_NOTE } from '../src/plugins/internal/languagetool';
import { INTERNAL_PLUGIN_DEFAULTS } from '../src/state/settings';
import { setup } from './helpers';

/**
 * r7 S8 (I-8) no app: registro `simplemd.languagetool` (desligado por padrão, opções, linha de
 * motivo STR-170 + "Como instalar"), AC-I8.1 (desligado → 0 chamadas ao transporte em 60 s;
 * ligado → explicação) e o caminho completo transporte → diagnósticos → barra de status.
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
      ['dictionary', 'info', 'Dicionário pessoal', undefined],
      ['disabledRules', 'list', 'Regras desativadas', []],
    ]);
    const info = options[2]?.info;
    const src = (values: Record<string, unknown>) => ({ values, readFile: async () => null });
    expect(info?.(src({}))).toBe('0 palavras');
    expect(info?.(src({ dictionary: ['a'] }))).toBe('1 palavra');
    expect(info?.(src({ dictionary: ['a', 'b'] }))).toBe('2 palavras');
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
  });

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
