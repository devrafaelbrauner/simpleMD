import { describe, expect, it } from 'vitest';
import { parseTaskLine, sameTask, scanTaskLine, type ParsedTask } from '../src/tasks/line';
import {
  addMonths,
  addYears,
  daysBetween,
  isValidTaskDate,
  localToday,
  msUntilLocalMidnight,
  nextWeekday,
  weekday,
} from '../src/tasks/dates';

/** Só os campos que o caso confere (o resto com os valores neutros). */
const task = (over: Partial<ParsedTask>): ParsedTask => ({
  line: -1,
  status: ' ',
  text: '',
  priority: 2,
  tags: [],
  invalid: [],
  ...over,
});

describe('AC-I9.2 — parser de linha de tarefa (R-I9.2): sinais, estados, datas, tags', () => {
  const cases: Array<[string, string, Partial<ParsedTask> | null]> = [
    // Estados e marcadores
    ['a fazer', '- [ ] comprar pão', { status: ' ', text: 'comprar pão' }],
    ['feita x', '- [x] feito', { status: 'x', text: 'feito' }],
    ['feita X', '* [X] feito', { status: 'X', text: 'feito' }],
    ['cancelada', '+ [-] largada', { status: '-', text: 'largada' }],
    ['em andamento', '- [/] metade', { status: '/', text: 'metade' }],
    ['outro caractere', '- [>] adiada', { status: '>', text: 'adiada' }],
    ['lista numerada', '1. [ ] primeiro', { text: 'primeiro' }],
    ['lista numerada )', '12) [x] doze', { status: 'x', text: 'doze' }],
    ['indentada', '    - [ ] filha', { text: 'filha' }],
    ['em citação', '> - [ ] citada', { text: 'citada' }],
    ['lista dentro de lista', '- - [ ] aninhada', { text: 'aninhada' }],
    ['tab depois do ]', '- [ ]\tcom tab', { text: 'com tab' }],
    // Sinais de data
    ['vencimento 📅', '- [ ] a 📅 2026-10-12', { text: 'a', due: '2026-10-12' }],
    ['vencimento 📆', '- [ ] a 📆 2026-10-12', { text: 'a', due: '2026-10-12' }],
    ['vencimento 🗓', '- [ ] a 🗓 2026-10-12', { text: 'a', due: '2026-10-12' }],
    ['agendada ⏳', '- [ ] a ⏳ 2026-10-11', { text: 'a', scheduled: '2026-10-11' }],
    ['agendada ⌛', '- [ ] a ⌛ 2026-10-11', { text: 'a', scheduled: '2026-10-11' }],
    ['início 🛫', '- [ ] a 🛫 2026-10-01', { text: 'a', start: '2026-10-01' }],
    ['criada ➕', '- [ ] a ➕ 2026-09-30', { text: 'a', created: '2026-09-30' }],
    ['concluída ✅', '- [x] a ✅ 2026-10-10', { status: 'x', text: 'a', done: '2026-10-10' }],
    ['cancelada ❌', '- [-] a ❌ 2026-10-09', { status: '-', text: 'a', cancelled: '2026-10-09' }],
    ['sem espaço após o sinal', '- [ ] a 📅2026-10-12', { text: 'a', due: '2026-10-12' }],
    ['seletor de variação', '- [ ] a ⏳\uFE0F 2026-10-11', { text: 'a', scheduled: '2026-10-11' }],
    // Prioridade
    ['prioridade máxima 🔺', '- [ ] a 🔺', { text: 'a', priority: 5 }],
    ['prioridade alta ⏫', '- [ ] a ⏫', { text: 'a', priority: 4 }],
    ['prioridade média 🔼', '- [ ] a 🔼', { text: 'a', priority: 3 }],
    ['prioridade baixa 🔽', '- [ ] a 🔽', { text: 'a', priority: 1 }],
    ['prioridade mínima ⏬', '- [ ] a ⏬', { text: 'a', priority: 0 }],
    // Recorrência e tags
    ['recorrência 🔁', '- [ ] a 🔁 every week', { text: 'a', recurrence: 'every week' }],
    [
      'recorrência + datas',
      '- [ ] a 🔁 every 2 weeks when done 📅 2026-10-12',
      { text: 'a', recurrence: 'every 2 weeks when done', due: '2026-10-12' },
    ],
    ['tags na descrição', '- [ ] ligar #casa e #urgente', {
      text: 'ligar #casa e #urgente',
      tags: ['#casa', '#urgente'],
    }],
    ['tag repetida sai uma vez', '- [ ] #a x #a', { text: '#a x #a', tags: ['#a'] }],
    ['tag no fim entre sinais', '- [ ] pagar 📅 2026-10-12 #financeiro ⏫', {
      text: 'pagar #financeiro',
      due: '2026-10-12',
      priority: 4,
      tags: ['#financeiro'],
    }],
    ['link de bloco no fim', '- [ ] a 📅 2026-10-12 ^abc-1', { text: 'a', due: '2026-10-12' }],
    // Todos juntos
    [
      'todos os sinais',
      '- [ ] relatório #trabalho 🔺 🔁 every month 🛫 2026-10-01 ⏳ 2026-10-05 📅 2026-10-12 ➕ 2026-09-30',
      {
        text: 'relatório #trabalho',
        priority: 5,
        recurrence: 'every month',
        start: '2026-10-01',
        scheduled: '2026-10-05',
        due: '2026-10-12',
        created: '2026-09-30',
        tags: ['#trabalho'],
      },
    ],
    // Datas inválidas: campo ignorado e marcado
    ['data inexistente', '- [ ] a 📅 2026-02-30', { text: 'a', invalid: ['due'] }],
    ['mês 13', '- [ ] a ⏳ 2026-13-01', { text: 'a', invalid: ['scheduled'] }],
    ['texto no lugar da data', '- [ ] a 🛫 amanhã', { text: 'a', invalid: ['start'] }],
    ['formato errado', '- [ ] a ✅ 10/10/2026', { text: 'a', invalid: ['done'] }],
    ['29/02 em ano bissexto vale', '- [ ] a 📅 2028-02-29', { text: 'a', due: '2028-02-29' }],
    // Não são tarefas
    ['sem espaço depois do ]', '- [ ]sem espaço', null],
    ['caixa vazia sem texto', '- [ ]', null],
    ['sem marcador', '[ ] solta', null],
    ['marcador sem espaço', '-[ ] a', null],
    ['parágrafo', 'texto comum', null],
  ];

  it(`tem ≥ 30 casos (${cases.length})`, () => {
    expect(cases.length).toBeGreaterThanOrEqual(30);
  });

  it.each(cases)('%s', (_name, line, expected) => {
    const parsed = parseTaskLine(line);
    if (expected === null) expect(parsed).toBeNull();
    else expect(parsed).toEqual(task(expected));
  });

  it('o número da linha passa adiante', () => {
    expect(parseTaskLine('- [ ] a', 7)?.line).toBe(7);
  });

  it('descrição > 1.000 caracteres é cortada; regra 🔁 > 200 é cortada', () => {
    const long = 'x'.repeat(1500);
    expect(parseTaskLine(`- [ ] ${long}`)?.text).toHaveLength(1000);
    const rule = `every ${'1'.repeat(300)} days`;
    expect(parseTaskLine(`- [ ] a 🔁 ${rule}`)?.recurrence).toHaveLength(200);
  });

  it('mais de 20 campos no fim: o laço para (rodadas limitadas)', () => {
    const many = Array.from({ length: 30 }, () => '🔺').join(' ');
    const parsed = parseTaskLine(`- [ ] a ${many}`);
    expect(parsed?.priority).toBe(5);
    expect(parsed?.text.startsWith('a')).toBe(true);
  });

  it('posições: estado, corpo e trecho de cada campo', () => {
    const raw = '  - [ ] a 📅 2026-10-12 ✅ 2026-10-13 ^id  ';
    const scan = scanTaskLine(raw)!;
    expect(raw[scan.statusOffset]).toBe(' ');
    expect(raw.slice(scan.bodyOffset, scan.bodyEnd)).toBe('a 📅 2026-10-12 ✅ 2026-10-13');
    const due = scan.spans.due!;
    expect(raw.slice(due.from, due.to)).toBe('📅 2026-10-12');
    expect(raw.slice(due.valueFrom, due.to)).toBe('2026-10-12');
    expect(raw.slice(scan.spans.done!.valueFrom, scan.spans.done!.to)).toBe('2026-10-13');
  });

  it('sameTask compara campo a campo, sem a linha', () => {
    const a = parseTaskLine('- [ ] a 📅 2026-10-12 #t', 1)!;
    expect(sameTask(a, parseTaskLine('* [ ] a 📅 2026-10-12 #t', 9)!)).toBe(true);
    expect(sameTask(a, parseTaskLine('- [x] a 📅 2026-10-12 #t')!)).toBe(false);
    expect(sameTask(a, parseTaskLine('- [ ] a 📅 2026-10-13 #t')!)).toBe(false);
    expect(sameTask(a, parseTaskLine('- [ ] a 📅 2026-10-12 #u')!)).toBe(false);
    expect(sameTask(a, parseTaskLine('- [ ] a 📅 2026-10-12 #t #u')!)).toBe(false);
    expect(sameTask(a, parseTaskLine('- [ ] a 📅 2026-10-12 #t ⏫')!)).toBe(false);
    const inv = parseTaskLine('- [ ] a 📅 x')!;
    expect(sameTask(inv, parseTaskLine('- [ ] a 📅 y')!)).toBe(true);
    expect(sameTask(inv, parseTaskLine('- [ ] a ⏳ y')!)).toBe(false);
  });
});

describe('datas das tarefas (fuso local, calendário)', () => {
  it('validação AAAA-MM-DD', () => {
    expect(isValidTaskDate('2026-10-10')).toBe(true);
    expect(isValidTaskDate('2026-00-10')).toBe(false);
    expect(isValidTaskDate('2026-10-32')).toBe(false);
    expect(isValidTaskDate('2027-02-29')).toBe(false);
    expect(isValidTaskDate('26-10-10')).toBe(false);
  });

  it('hoje e a meia-noite seguem o fuso local', () => {
    const at = new Date(2026, 9, 10, 23, 59, 30);
    expect(localToday(at)).toBe('2026-10-10');
    expect(msUntilLocalMidnight(at)).toBe(30_000);
    expect(localToday(new Date(2026, 0, 2))).toBe('2026-01-02');
  });

  it('mês curto → último dia; ano bissexto; dia da semana', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2028-01-31', 1)).toBe('2028-02-29');
    expect(addMonths('2026-12-15', 1)).toBe('2027-01-15');
    expect(addMonths('2026-03-31', -1)).toBe('2026-02-28');
    expect(addYears('2028-02-29', 1)).toBe('2029-02-28');
    expect(daysBetween('2026-10-10', '2026-11-10')).toBe(31);
    expect(weekday('2026-10-09')).toBe(5); // sexta
    expect(nextWeekday('2026-10-09')).toBe('2026-10-12'); // sexta → segunda
    expect(nextWeekday('2026-10-10')).toBe('2026-10-12'); // sábado → segunda
    expect(nextWeekday('2026-10-12')).toBe('2026-10-13');
  });
});
