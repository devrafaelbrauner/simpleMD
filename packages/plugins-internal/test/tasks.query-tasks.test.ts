import { describe, expect, it } from 'vitest';
import {
  parseTasksQuery,
  resolveDateRef,
  type TaskFilter,
  type TasksQuery,
} from '../src/tasks/query/tasks-parser';

const ok = (source: string): TasksQuery => {
  const parsed = parseTasksQuery(source);
  if (parsed.kind === 'error') throw new Error(parsed.message);
  return parsed;
};
const filter = (source: string): TaskFilter => {
  const parsed = ok(source);
  expect(parsed.filters).toHaveLength(1);
  return parsed.filters[0]!;
};

// AC-I9.3: ≥ 40 instruções aceitas (cada instrução de R-I9.4) com a árvore esperada.
const ACCEPTED: readonly [string, TaskFilter][] = [
  ['done', { kind: 'done', done: true }],
  ['not done', { kind: 'done', done: false }],
  ['DONE', { kind: 'done', done: true }],
  ['  not   done  ', { kind: 'done', done: false }],
  ['due before today', { kind: 'date', field: 'due', op: 'before', date: { offset: 0 } }],
  ['due after tomorrow', { kind: 'date', field: 'due', op: 'after', date: { offset: 1 } }],
  ['due on yesterday', { kind: 'date', field: 'due', op: 'on', date: { offset: -1 } }],
  ['due on 2026-10-12', { kind: 'date', field: 'due', op: 'on', date: { date: '2026-10-12' } }],
  [
    'scheduled before 2026-01-31',
    { kind: 'date', field: 'scheduled', op: 'before', date: { date: '2026-01-31' } },
  ],
  ['scheduled on today', { kind: 'date', field: 'scheduled', op: 'on', date: { offset: 0 } }],
  [
    'starts after 2024-02-29',
    { kind: 'date', field: 'start', op: 'after', date: { date: '2024-02-29' } },
  ],
  ['starts before today', { kind: 'date', field: 'start', op: 'before', date: { offset: 0 } }],
  [
    'done after 2026-10-01',
    { kind: 'date', field: 'done', op: 'after', date: { date: '2026-10-01' } },
  ],
  ['done on today', { kind: 'date', field: 'done', op: 'on', date: { offset: 0 } }],
  [
    'created before 2026-10-10',
    { kind: 'date', field: 'created', op: 'before', date: { date: '2026-10-10' } },
  ],
  ['Created On Today', { kind: 'date', field: 'created', op: 'on', date: { offset: 0 } }],
  ['has due date', { kind: 'has-date', field: 'due', has: true }],
  ['no due date', { kind: 'has-date', field: 'due', has: false }],
  ['has scheduled date', { kind: 'has-date', field: 'scheduled', has: true }],
  ['no scheduled date', { kind: 'has-date', field: 'scheduled', has: false }],
  ['has start date', { kind: 'has-date', field: 'start', has: true }],
  ['no start date', { kind: 'has-date', field: 'start', has: false }],
  ['has done date', { kind: 'has-date', field: 'done', has: true }],
  ['no done date', { kind: 'has-date', field: 'done', has: false }],
  ['path includes Projetos/', { kind: 'path', includes: true, text: 'Projetos/' }],
  ['path does not include arquivo morto', { kind: 'path', includes: false, text: 'arquivo morto' }],
  ['tags include #casa', { kind: 'tag', includes: true, tag: '#casa' }],
  [
    'tags do not include #trabalho/reuniao',
    { kind: 'tag', includes: false, tag: '#trabalho/reuniao' },
  ],
  ['tag includes #urgente', { kind: 'tag', includes: true, tag: '#urgente' }],
  ['tag does not include #talvez', { kind: 'tag', includes: false, tag: '#talvez' }],
  [
    'description includes comprar pão',
    { kind: 'description', includes: true, text: 'comprar pão' },
  ],
  ['description does not include ligar', { kind: 'description', includes: false, text: 'ligar' }],
  ['priority is highest', { kind: 'priority', cmp: 'is', level: 5 }],
  ['priority is high', { kind: 'priority', cmp: 'is', level: 4 }],
  ['priority is medium', { kind: 'priority', cmp: 'is', level: 3 }],
  ['priority is none', { kind: 'priority', cmp: 'is', level: 2 }],
  ['priority is low', { kind: 'priority', cmp: 'is', level: 1 }],
  ['priority is lowest', { kind: 'priority', cmp: 'is', level: 0 }],
  ['priority is above medium', { kind: 'priority', cmp: 'above', level: 3 }],
  ['priority is below none', { kind: 'priority', cmp: 'below', level: 2 }],
  ['is recurring', { kind: 'recurring', recurring: true }],
  ['is not recurring', { kind: 'recurring', recurring: false }],
  [
    '(due before today) AND (priority is high)',
    {
      kind: 'and',
      operands: [
        { kind: 'date', field: 'due', op: 'before', date: { offset: 0 } },
        { kind: 'priority', cmp: 'is', level: 4 },
      ],
    },
  ],
  [
    '(tags include #a) OR (tags include #b) OR (path includes x)',
    {
      kind: 'or',
      operands: [
        { kind: 'tag', includes: true, tag: '#a' },
        { kind: 'tag', includes: true, tag: '#b' },
        { kind: 'path', includes: true, text: 'x' },
      ],
    },
  ],
  ['NOT (done)', { kind: 'not', operand: { kind: 'done', done: true } }],
  [
    '((done) OR (is recurring)) AND NOT (has due date)',
    {
      kind: 'and',
      operands: [
        {
          kind: 'or',
          operands: [
            { kind: 'done', done: true },
            { kind: 'recurring', recurring: true },
          ],
        },
        { kind: 'not', operand: { kind: 'has-date', field: 'due', has: true } },
      ],
    },
  ],
  [
    '(done) OR (not done) AND (no due date)',
    {
      kind: 'or',
      operands: [
        { kind: 'done', done: true },
        {
          kind: 'and',
          operands: [
            { kind: 'done', done: false },
            { kind: 'has-date', field: 'due', has: false },
          ],
        },
      ],
    },
  ],
];

describe('parser tasks: instruções aceitas (AC-I9.3)', () => {
  it('tem ≥ 40 casos', () => expect(ACCEPTED.length).toBeGreaterThanOrEqual(40));
  it.each(ACCEPTED)('%s', (source, expected) => expect(filter(source)).toEqual(expected));
});

describe('parser tasks: layout, ordenação, grupos, limite', () => {
  it('sort by (várias, com reverse), group by, limit, hide/show, short mode', () => {
    const q = ok(
      [
        'not done',
        '',
        'sort by due',
        'sort by priority reverse',
        'SORT BY path',
        'group by folder',
        'group by tags',
        'limit 100',
        'hide due date',
        'hide backlink',
        'show due date',
        'short mode',
      ].join('\n'),
    );
    expect(q.sort).toEqual([
      { key: 'due', reverse: false },
      { key: 'priority', reverse: true },
      { key: 'path', reverse: false },
    ]);
    expect(q.group).toEqual(['folder', 'tags']);
    expect(q.limit).toBe(100);
    expect([...q.hide]).toEqual(['backlink']);
    expect(q.shortMode).toBe(true);
  });

  it.each(['sort by scheduled', 'sort by start', 'sort by done', 'sort by description reverse'])(
    '%s',
    (line) => expect(ok(line).sort).toHaveLength(1),
  );

  it.each(['group by path', 'group by filename', 'group by due', 'group by priority'])(
    '%s',
    (line) => expect(ok(line).group).toHaveLength(1),
  );

  it.each(['limit 0', 'limit 1000', 'limit to 5 tasks'])('%s', (line) =>
    expect(ok(line).limit).not.toBeNull(),
  );

  it.each([
    'hide scheduled date',
    'hide start date',
    'hide done date',
    'hide priority',
    'hide recurrence rule',
  ])('%s', (line) => expect(ok(line).hide.size).toBe(1));

  it('bloco vazio = todas as tarefas, sem limite explícito', () => {
    expect(ok('\n  \n')).toMatchObject({ filters: [], sort: [], group: [], limit: null });
  });

  it('CRLF e várias instruções', () => {
    expect(ok('not done\r\ndue before today\r\n').filters).toHaveLength(2);
  });
});

// AC-I9.3: ≥ 15 recusadas com "Instrução não reconhecida na linha N: <texto>".
const REFUSED: readonly [string, number, string][] = [
  ['due befor today', 1, 'due befor today'],
  ['not done\ndue before amanhã', 2, 'due before amanhã'],
  ['due before 2026-02-30', 1, 'due before 2026-02-30'],
  ['due before 12/10/2026', 1, 'due before 12/10/2026'],
  ['has created date', 1, 'has created date'],
  ['path contains x', 1, 'path contains x'],
  ['tags include casa', 1, 'tags include casa'],
  ['priority is urgent', 1, 'priority is urgent'],
  ['priority above high', 1, 'priority above high'],
  ['sort by urgency', 1, 'sort by urgency'],
  ['group by status', 1, 'group by status'],
  ['limit 1001', 1, 'limit 1001'],
  ['limit -1', 1, 'limit -1'],
  ['(done) AND', 1, '(done) AND'],
  ['(done) and (not done)', 1, '(done) and (not done)'],
  ['NOT (due befor today)', 1, 'NOT (due befor today)'],
  ['(due before today', 1, '(due before today'],
  ['(foo) OR (done)', 1, '(foo) OR (done)'],
  ['\n\n  hide everything  ', 3, 'hide everything'],
  ['explain', 1, 'explain'],
];

describe('parser tasks: recusas (AC-I9.3)', () => {
  it('tem ≥ 15 casos', () => expect(REFUSED.length).toBeGreaterThanOrEqual(15));
  it.each(REFUSED)('%j → linha %i', (source, line, text) => {
    expect(parseTasksQuery(source)).toEqual({
      kind: 'error',
      line,
      message: `Instrução não reconhecida na linha ${line}: ${text}`,
    });
  });
});

describe('datas relativas', () => {
  it('today/tomorrow/yesterday seguem o dia passado', () => {
    expect(resolveDateRef({ offset: 0 }, '2026-12-31')).toBe('2026-12-31');
    expect(resolveDateRef({ offset: 1 }, '2026-12-31')).toBe('2027-01-01');
    expect(resolveDateRef({ offset: -1 }, '2026-03-01')).toBe('2026-02-28');
    expect(resolveDateRef({ date: '2026-10-12' }, '2026-12-31')).toBe('2026-10-12');
  });
});
