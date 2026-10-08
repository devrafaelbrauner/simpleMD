// @vitest-environment jsdom
import {
  completionStatus,
  currentCompletions,
  selectedCompletionIndex,
  startCompletion,
} from '@codemirror/autocomplete';
import { StateEffect } from '@codemirror/state';
import { EditorView, runScopeHandlers } from '@codemirror/view';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COMPLETION_ANNOUNCE_DELAY_MS } from '../src/autocomplete/announce';
import {
  appCompletionSources,
  DEFAULT_AUTOCOMPLETE,
  EditorHost,
  EMPTY_CONTRIBUTIONS,
} from '../src';

const words = appCompletionSources(DEFAULT_AUTOCOMPLETE, {
  notes: () => [],
  today: () => '2026-10-07',
})[0]!;

const key = (view: EditorView, name: string) =>
  runScopeHandlers(view, new KeyboardEvent('keydown', { key: name }), 'editor');

/** Editor do host com as palavras do app; `announced` guarda cada efeito `EditorView.announce`. */
function editor(doc: string, enabled = true) {
  const host = new EditorHost({
    ...EMPTY_CONTRIBUTIONS,
    completion: { enabled, activateOnTyping: true, sources: [words] },
  });
  const parent = document.createElement('div');
  document.body.append(parent);
  const view = new EditorView({ state: host.createState(doc), parent });
  const announced: string[] = [];
  view.dispatch({
    effects: StateEffect.appendConfig.of(
      EditorView.updateListener.of((u) => {
        for (const tr of u.transactions)
          for (const effect of tr.effects)
            if (effect.is(EditorView.announce)) announced.push(effect.value);
      }),
    ),
  });
  return { view, announced };
}

async function type(view: EditorView, text: string, gapMs = 0) {
  for (const [i, char] of [...text].entries()) {
    if (i > 0) await vi.advanceTimersByTimeAsync(gapMs);
    const at = view.state.doc.length;
    view.dispatch({
      changes: { from: at, insert: char },
      selection: { anchor: at + 1 },
      userEvent: 'input.type',
    });
  }
}

describe('A11Y-R5-01 (AC-B14.1): contagem de sugestões na região polida do editor', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
    document.body.replaceChildren();
  });

  it('popup com N opções → "N sugestões, ↓ para escolher" depois da pausa; nada mais muda', async () => {
    const { view, announced } = editor('parabéns paralelepípedo paralelo\n');
    const focused = document.activeElement;
    await type(view, 'par');
    await vi.advanceTimersByTimeAsync(0);
    expect(completionStatus(view.state)).toBe('active');
    const n = currentCompletions(view.state).length;
    expect(n).toBe(3);
    expect(announced).toEqual([]);
    const live = view.dom.querySelector<HTMLElement>('.cm-announced')!;
    expect(live.textContent).toBe('');

    await vi.advanceTimersByTimeAsync(COMPLETION_ANNOUNCE_DELAY_MS);
    expect(announced).toEqual(['3 sugestões, ↓ para escolher']);
    expect(live.textContent).toBe('3 sugestões, ↓ para escolher');
    expect(live.getAttribute('aria-live')).toBe('polite');
    expect(live.closest('[aria-hidden="true"]')).toBeNull();
    // R4-02: o anúncio não muda o popup nem ativa uma opção (Enter continua quebrando a linha).
    expect(completionStatus(view.state)).toBe('active');
    expect(currentCompletions(view.state)).toHaveLength(n);
    expect(selectedCompletionIndex(view.state)).toBeNull();
    expect(document.activeElement).toBe(focused);
    view.destroy();
  });

  it('uma opção → "1 sugestão, ↓ para escolher"', async () => {
    const { view, announced } = editor('paralelepípedo\n');
    await type(view, 'par');
    await vi.advanceTimersByTimeAsync(COMPLETION_ANNOUNCE_DELAY_MS);
    expect(currentCompletions(view.state)).toHaveLength(1);
    expect(announced).toEqual(['1 sugestão, ↓ para escolher']);
    view.destroy();
  });

  it('↓/↑ não são anunciadas', async () => {
    const { view, announced } = editor('parabéns paralelepípedo paralelo\n');
    await type(view, 'par');
    await vi.advanceTimersByTimeAsync(COMPLETION_ANNOUNCE_DELAY_MS);
    expect(announced).toHaveLength(1);
    expect(key(view, 'ArrowDown')).toBe(true);
    expect(key(view, 'ArrowDown')).toBe(true);
    expect(key(view, 'ArrowUp')).toBe(true);
    await vi.advanceTimersByTimeAsync(COMPLETION_ANNOUNCE_DELAY_MS * 2);
    expect(selectedCompletionIndex(view.state)).toBe(0);
    expect(announced).toHaveLength(1);
    view.destroy();
  });

  it('rajada a 80 ms/tecla → um anúncio depois da pausa; fechar e reabrir anuncia de novo', async () => {
    const { view, announced } = editor('parabéns paralelepípedo paralelo\n');
    await type(view, 'para', 80);
    await vi.advanceTimersByTimeAsync(COMPLETION_ANNOUNCE_DELAY_MS - 1);
    expect(announced).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(announced).toEqual(['3 sugestões, ↓ para escolher']);

    expect(key(view, 'Escape')).toBe(true);
    expect(completionStatus(view.state)).toBeNull();
    expect(startCompletion(view)).toBe(true);
    // O resultado de uma abertura explícita chega depois do debounce interno do CodeMirror.
    await vi.advanceTimersByTimeAsync(100);
    expect(currentCompletions(view.state)).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(COMPLETION_ANNOUNCE_DELAY_MS);
    expect(announced).toEqual(['3 sugestões, ↓ para escolher', '3 sugestões, ↓ para escolher']);
    view.destroy();
  });

  it('sugestões desligadas → nenhum anúncio', async () => {
    const { view, announced } = editor('parabéns paralelepípedo paralelo\n', false);
    await type(view, 'par');
    await vi.advanceTimersByTimeAsync(COMPLETION_ANNOUNCE_DELAY_MS * 2);
    expect(completionStatus(view.state)).toBeNull();
    expect(announced).toEqual([]);
    view.destroy();
  });
});
