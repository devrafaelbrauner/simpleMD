// @vitest-environment jsdom
import { undo } from '@codemirror/commands';
import { EditorState, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMarkdownExtensions, loadTaskCompletion, taskToggleFacet } from '../src';
import { taskCompletionSemantics, toggleTaskLine } from '../src/tasks/complete';
import { nextOccurrence, parseRecurrence } from '../src/tasks/recurrence';
import { toggleTaskCommand } from '../src/tasks/semantics';
import { fullyParsed } from './helpers/live-preview';

const TODAY = '2026-10-10';
const on = { today: TODAY, recordDoneDate: true };

const views: EditorView[] = [];
afterEach(() => {
  while (views.length) views.pop()?.destroy();
  document.body.innerHTML = '';
});

function mount(doc: string, extensions: Extension[], anchor = 0): EditorView {
  const parent = document.body.appendChild(document.createElement('div'));
  const state = EditorState.create({
    doc,
    selection: { anchor },
    extensions: [createMarkdownExtensions(), ...extensions],
  });
  const view = new EditorView({ state, parent });
  views.push(view);
  return fullyParsed(view);
}

describe('AC-I9.6 — conclusão: ✅ acrescentada e removida', () => {
  it('[ ] → [x] acrescenta " ✅ hoje"; reabrir remove o ✅', () => {
    const done = toggleTaskLine('- [ ] pagar conta 📅 2026-10-12', on)!;
    expect(done.lines).toEqual(['- [x] pagar conta 📅 2026-10-12 ✅ 2026-10-10']);
    expect(done.recurred).toBe(false);
    const undone = toggleTaskLine(done.lines[0]!, on)!;
    expect(undone.lines).toEqual(['- [ ] pagar conta 📅 2026-10-12']);
  });

  it('opção desligada: só o caractere muda', () => {
    expect(toggleTaskLine('- [ ] a', { today: TODAY, recordDoneDate: false })!.lines).toEqual([
      '- [x] a',
    ]);
  });

  it('o ✅ entra antes do link de bloco e dos espaços do fim', () => {
    expect(toggleTaskLine('- [ ] a ^id-1  ', on)!.lines).toEqual(['- [x] a ✅ 2026-10-10 ^id-1  ']);
  });

  it('estados: / → x (com ✅), - → espaço, outro → x, X → espaço (sem ✅)', () => {
    expect(toggleTaskLine('- [/] a', on)!.lines).toEqual(['- [x] a ✅ 2026-10-10']);
    expect(toggleTaskLine('- [-] a ❌ 2026-10-01', on)!.lines).toEqual(['- [ ] a ❌ 2026-10-01']);
    expect(toggleTaskLine('- [>] a', on)!.lines).toEqual(['- [x] a ✅ 2026-10-10']);
    expect(toggleTaskLine('- [X] a ✅ 2026-10-01', on)!.lines).toEqual(['- [ ] a']);
  });

  it('já tem ✅: concluir não duplica', () => {
    expect(toggleTaskLine('- [ ] a ✅ 2026-10-01', on)!.lines).toEqual(['- [x] a ✅ 2026-10-01']);
  });

  it('linha que não é tarefa → null', () => {
    expect(toggleTaskLine('texto', on)).toBeNull();
  });
});

describe('AC-I9.6 — recorrência (subconjunto de R-I9.7)', () => {
  const cases: Array<[string, string, string]> = [
    ['every day', '- [ ] a 🔁 every day 📅 2026-10-10', '- [ ] a 🔁 every day 📅 2026-10-11'],
    [
      'every 2 weeks',
      '- [ ] a 🔁 every 2 weeks 📅 2026-10-10',
      '- [ ] a 🔁 every 2 weeks 📅 2026-10-24',
    ],
    [
      'every month 31/01 → 28/02',
      '- [ ] a 🔁 every month 📅 2026-01-31',
      '- [ ] a 🔁 every month 📅 2026-02-28',
    ],
    [
      'every month 31/01 → 29/02 (bissexto)',
      '- [ ] a 🔁 every month 📅 2028-01-31',
      '- [ ] a 🔁 every month 📅 2028-02-29',
    ],
    ['every year', '- [ ] a 🔁 every year 📅 2026-10-10', '- [ ] a 🔁 every year 📅 2027-10-10'],
    [
      'every weekday (sexta → segunda)',
      '- [ ] a 🔁 every weekday 📅 2026-10-09',
      '- [ ] a 🔁 every weekday 📅 2026-10-12',
    ],
    [
      'when done (a partir de hoje)',
      '- [ ] a 🔁 every 3 days when done 📅 2026-09-01',
      '- [ ] a 🔁 every 3 days when done 📅 2026-10-13',
    ],
  ];

  it.each(cases)('%s', (_name, line, next) => {
    const result = toggleTaskLine(line, on)!;
    expect(result.recurred).toBe(true);
    expect(result.lines).toEqual([next, `${line.replace('[ ]', '[x]')} ✅ 2026-10-10`]);
  });

  it('as outras datas andam junto com a de referência; ✅/❌/➕ e link de bloco não passam', () => {
    const result = toggleTaskLine(
      '- [ ] a 🔁 every week ➕ 2026-09-01 🛫 2026-10-01 ⏳ 2026-10-08 📅 2026-10-10 ^x',
      on,
    )!;
    expect(result.lines[0]).toBe('- [ ] a 🔁 every week 🛫 2026-10-08 ⏳ 2026-10-15 📅 2026-10-17');
    expect(result.nextDate).toBe('2026-10-17');
  });

  it('referência é a agendada quando não há vencimento', () => {
    const result = toggleTaskLine('- [ ] a 🔁 every day ⏳ 2026-10-05', on)!;
    expect(result.lines[0]).toBe('- [ ] a 🔁 every day ⏳ 2026-10-06');
  });

  it('sem datas: a próxima ocorrência nasce igual, sem ✅', () => {
    const result = toggleTaskLine('- [ ] regar 🔁 every day', on)!;
    expect(result.lines).toEqual([
      '- [ ] regar 🔁 every day',
      '- [x] regar 🔁 every day ✅ 2026-10-10',
    ]);
    expect(result.nextDate).toBeUndefined();
  });

  it('regra não suportada → só alterna + nome da regra', () => {
    const result = toggleTaskLine('- [ ] a 🔁 every 3rd tuesday 📅 2026-10-10', on)!;
    expect(result.lines).toEqual(['- [x] a 🔁 every 3rd tuesday 📅 2026-10-10 ✅ 2026-10-10']);
    expect(result.unsupportedRule).toBe('every 3rd tuesday');
  });

  it('reabrir uma recorrente não cria ocorrência', () => {
    const result = toggleTaskLine('- [x] a 🔁 every day ✅ 2026-10-09', on)!;
    expect(result.lines).toEqual(['- [ ] a 🔁 every day']);
  });

  it('parser da regra: aceitos e recusados', () => {
    expect(parseRecurrence('every day')).toEqual({ unit: 'day', interval: 1, whenDone: false });
    expect(parseRecurrence('Every 2  Weeks when done')).toEqual({
      unit: 'week',
      interval: 2,
      whenDone: true,
    });
    expect(parseRecurrence('every weekday when done')?.whenDone).toBe(true);
    expect(parseRecurrence('every 0 days')).toBeNull();
    expect(parseRecurrence('every monday')).toBeNull();
    expect(parseRecurrence('every month on the 1st')).toBeNull();
    expect(nextOccurrence({ unit: 'year', interval: 1, whenDone: false }, '2028-02-29')).toBe(
      '2029-02-28',
    );
  });
});

describe('AC-I9.6 — no editor: Mod-L / clique com a semântica de R-I9.7 (taskToggleFacet)', () => {
  const semantics = (onUnsupportedRule = vi.fn()) =>
    taskToggleFacet.of(
      taskCompletionSemantics({
        recordDoneDate: () => true,
        today: () => TODAY,
        onUnsupportedRule,
      }),
    );

  it('concluir acrescenta ✅; desfazer (Mod-Z) remove — um passo', () => {
    const doc = '- [ ] a\n\nfim\n';
    const view = mount(doc, [semantics()]);
    expect(toggleTaskCommand(view)).toBe(true);
    expect(view.state.doc.toString()).toBe('- [x] a ✅ 2026-10-10\n\nfim\n');
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe(doc);
    expect(undo(view)).toBe(false);
  });

  it('recorrência insere a próxima acima; anúncio com a data', () => {
    const doc = '- [ ] a 🔁 every day 📅 2026-10-10\n';
    const view = mount(doc, [semantics()]);
    const announced: string[] = [];
    const original = view.dispatch.bind(view);
    vi.spyOn(view, 'dispatch').mockImplementation((...args: unknown[]) => {
      const spec = args[0] as { effects?: { value: unknown } };
      if (typeof spec.effects?.value === 'string') announced.push(spec.effects.value);
      original(...(args as Parameters<typeof original>));
    });
    toggleTaskCommand(view);
    expect(view.state.doc.toString()).toBe(
      '- [ ] a 🔁 every day 📅 2026-10-11\n- [x] a 🔁 every day 📅 2026-10-10 ✅ 2026-10-10\n',
    );
    expect(announced).toEqual(['Tarefa concluída. Próxima repetição criada para 2026-10-11.']);
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe(doc);
  });

  it('regra não suportada → avisa o app com o nome da regra', () => {
    const warn = vi.fn();
    const view = mount('- [ ] a 🔁 every 3rd tuesday\n', [semantics(warn)]);
    toggleTaskCommand(view);
    expect(warn).toHaveBeenCalledWith('every 3rd tuesday');
    expect(view.state.doc.line(1).text).toBe('- [x] a 🔁 every 3rd tuesday ✅ 2026-10-10');
  });

  it('várias linhas: um passo, anúncio "<n> tarefas alternadas."; reabrir anuncia', () => {
    const doc = '- [ ] a\n- [x] b ✅ 2026-10-01\n';
    const view = mount(doc, [semantics()]);
    view.dispatch({ selection: { anchor: 0, head: doc.length - 1 } });
    toggleTaskCommand(view);
    expect(view.state.doc.toString()).toBe('- [x] a ✅ 2026-10-10\n- [ ] b\n');
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe(doc);
    const single = taskCompletionSemantics({ recordDoneDate: () => true, today: () => TODAY });
    const state = view.state;
    expect(single(state, [{ markerFrom: 8, status: 'x' }]).announce).toBe('Tarefa reaberta.');
  });

  it('tarefa que a linha sozinha não descreve: troca só o caractere (fallback)', () => {
    const state = EditorState.create({ doc: 'xx [ ] a' });
    const result = taskCompletionSemantics({ recordDoneDate: () => true })(state, [
      { markerFrom: 3, status: ' ' },
    ]);
    expect(result.changes).toEqual([{ from: 4, to: 5, insert: 'x' }]);
    expect(result.announce).toBe('Tarefa concluída.');
  });

  it('a conclusão carrega sob demanda pelo índice do core (pedaço próprio, NFR-54)', async () => {
    const mod = await loadTaskCompletion();
    expect(mod.toggleTaskLine).toBe(toggleTaskLine);
  });
});
