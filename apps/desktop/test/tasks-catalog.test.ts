// @vitest-environment jsdom
import '../../../packages/core/test/setup-dom';
import { createHash } from 'node:crypto';
import { history, undo } from '@codemirror/commands';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { loadTaskCompletion, noteContext } from '@simplemd/core';
import type { IndexedNote, TasksCatalog } from '@simplemd/plugin-api/internal/tasks-catalog';
import type { IndexEntry } from '@simplemd/vault';
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
  createTasksCatalog,
  TASKS_CATALOG_TEXT,
  type AppTasksCatalog,
  type CatalogTaskRef,
} from '../src/catalog/tasks-catalog';
import { setup, type Harness } from './helpers';

const sha = (text: string | Uint8Array) => createHash('sha256').update(text).digest('hex');
/** O parser de linha chega com a conclusão (pedaço sob demanda, NFR-54). */
const { parseTaskLine } = await loadTaskCompletion();
const decode = (bytes: Uint8Array | null | undefined) =>
  new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes ?? undefined);

const views: EditorView[] = [];
afterEach(() => {
  while (views.length) views.pop()?.destroy();
  document.body.innerHTML = '';
  vi.useRealTimers();
});

/** Editor principal mostrando a aba `path` (cada transação vai para a sincronização). */
function mountActive(h: Harness, path: string): EditorView {
  const record = h.app.registry.get(path)!;
  const parent = document.body.appendChild(document.createElement('div'));
  const view: EditorView = new EditorView({
    parent,
    state: EditorState.create({
      doc: record.state.doc,
      extensions: [history(), noteContext.of({ path })],
    }),
    dispatchTransactions(trs) {
      view.update(trs);
      h.app.sync.onEditorChange(path, view.state);
    },
  });
  views.push(view);
  return view;
}

async function catalogFor(h: Harness, view: () => EditorView | null = () => null) {
  const completion = await loadTaskCompletion();
  const catalog = createTasksCatalog({
    vault: h.platform.vault,
    store: h.app.store,
    registry: h.app.registry,
    catalog: h.app.catalog,
    sync: h.app.sync,
    view,
    completion,
    today: () => '2026-10-10',
  });
  return catalog;
}

const ref = (path: string, text: string, line: number): CatalogTaskRef => {
  const raw = text.replace(/^\uFEFF/, '').split(/\r\n|\r|\n/)[line]!;
  return { path, task: parseTaskLine(raw, line)! };
};

const writesTo = (h: Harness, path: string) =>
  h.port.calls().filter((c) => c.op === 'writeFile' && c.abs.endsWith(`/${path}`));

describe('AC-I9.1 (tipos) — a implementação do app é um TasksCatalog; IndexEntry ⊇ IndexedNote', () => {
  it('formas compatíveis em tempo de compilação', () => {
    expectTypeOf<IndexEntry>().toExtend<IndexedNote>();
    expectTypeOf<AppTasksCatalog>().toExtend<TasksCatalog>();
    expectTypeOf<keyof TasksCatalog>().toEqualTypeOf<
      | 'getSnapshot'
      | 'subscribe'
      | 'resolveWikilink'
      | 'backlinks'
      | 'parseTaskLine'
      | 'editTask'
      | 'toggleTask'
      | 'openSource'
      | 'openNote'
    >();
  });
});

describe('AC-I9.7 (VT) — editTask: alvo fechado → 1 gravação segura, diff só da linha', () => {
  it('LF: uma gravação; só a linha da tarefa muda; o índice recebe a gravação', async () => {
    const text = '# Nota\n\n- [ ] a\n- [ ] b 📅 2026-10-12\nfim\n';
    const h = await setup({ 'n.md': text });
    const catalog = await catalogFor(h);
    const saved = vi.spyOn(h.app.catalog, 'saved');
    h.port.resetCalls();
    const result = await catalog.toggleTask(ref('n.md', text, 3), { recordDoneDate: true });
    expect(result).toEqual({ ok: true, target: 'disk' });
    expect(writesTo(h, 'n.md')).toHaveLength(1);
    const after = decode(h.port.readBytes('n.md'));
    expect(after).toBe('# Nota\n\n- [ ] a\n- [x] b 📅 2026-10-12 ✅ 2026-10-10\nfim\n');
    const diff = after.split('\n').filter((line, i) => line !== text.split('\n')[i]);
    expect(diff).toEqual(['- [x] b 📅 2026-10-12 ✅ 2026-10-10']);
    expect(saved).toHaveBeenCalledWith('n.md', after, expect.any(Number));
  });

  it('CRLF + BOM preservados; recorrência = 2 linhas com a quebra da própria linha', async () => {
    const text = '\uFEFF# N\r\n- [ ] r 🔁 every day 📅 2026-10-10\r\nfim\r\n';
    const h = await setup({ 'c.md': text });
    const catalog = await catalogFor(h);
    h.port.resetCalls();
    const result = await catalog.toggleTask(ref('c.md', text, 1), { recordDoneDate: true });
    expect(result.ok).toBe(true);
    expect(writesTo(h, 'c.md')).toHaveLength(1);
    expect(decode(h.port.readBytes('c.md'))).toBe(
      '\uFEFF# N\r\n- [ ] r 🔁 every day 📅 2026-10-11\r\n- [x] r 🔁 every day 📅 2026-10-10 ✅ 2026-10-10\r\nfim\r\n',
    );
  });

  it('linha mudada no disco → 0 gravações + aviso STR-177 + reindexação', async () => {
    const text = '- [ ] a\n';
    const h = await setup({ 'm.md': text });
    const catalog = await catalogFor(h);
    const stale = ref('m.md', text, 0);
    h.port.externalWrite('m.md', '- [ ] a mudada\n');
    const changed = vi.spyOn(h.app.catalog, 'changed');
    h.port.resetCalls();
    const result = await catalog.toggleTask(stale, { recordDoneDate: true });
    expect(result).toEqual({ ok: false, reason: 'changed' });
    expect(writesTo(h, 'm.md')).toHaveLength(0);
    expect(changed).toHaveBeenCalledWith(['m.md']);
    expect(h.app.store.getState().notices.at(-1)?.text).toBe(TASKS_CATALOG_TEXT.changed);
  });

  it('linha some (arquivo encurtou) → changed; arquivo apagado → missing; ambos 0 gravações', async () => {
    const text = '# a\n- [ ] a\n';
    const h = await setup({ 'x.md': text, 'y.md': text });
    const catalog = await catalogFor(h);
    h.port.externalWrite('x.md', '# a\n');
    expect(await catalog.editTask(ref('x.md', text, 1), () => ['z'])).toEqual({
      ok: false,
      reason: 'changed',
    });
    h.port.remove('y.md');
    expect(await catalog.toggleTask(ref('y.md', text, 1), { recordDoneDate: true })).toEqual({
      ok: false,
      reason: 'missing',
    });
    expect(h.port.calls().filter((c) => c.op === 'writeFile')).toHaveLength(0);
  });

  it('gravação perde a corrida (outro processo gravou entre ler e gravar) → 0 gravações, changed', async () => {
    const text = '- [ ] a\n';
    const h = await setup({ 'r.md': text });
    const catalog = await catalogFor(h);
    const original = h.platform.vault.read.bind(h.platform.vault);
    vi.spyOn(h.platform.vault, 'read').mockImplementationOnce(async (handle, path) => {
      const value = await original(handle, path);
      h.port.externalWrite('r.md', '- [ ] a\n\nnovo\n');
      return value;
    });
    h.port.resetCalls();
    const result = await catalog.editTask(ref('r.md', text, 0), () => ['- [x] a']);
    expect(result).toEqual({ ok: false, reason: 'changed' });
    expect(decode(h.port.readBytes('r.md'))).toBe('- [ ] a\n\nnovo\n');
  });

  it('transform nulo ou igual → 0 gravações (unchanged)', async () => {
    const text = '- [ ] a\n';
    const h = await setup({ 'u.md': text });
    const catalog = await catalogFor(h);
    h.port.resetCalls();
    expect(await catalog.editTask(ref('u.md', text, 0), () => null)).toEqual({
      ok: false,
      reason: 'unchanged',
    });
    expect(await catalog.editTask(ref('u.md', text, 0), (raw) => [raw])).toEqual({
      ok: false,
      reason: 'unchanged',
    });
    expect(h.writes()).toBe(0);
  });

  it('clique repetido em voo → a segunda chamada é ignorada (1 gravação)', async () => {
    const text = '- [ ] a\n';
    const h = await setup({ 'd.md': text });
    const catalog = await catalogFor(h);
    h.port.resetCalls();
    const target = ref('d.md', text, 0);
    const [first, second] = await Promise.all([
      catalog.toggleTask(target, { recordDoneDate: true }),
      catalog.toggleTask(target, { recordDoneDate: true }),
    ]);
    expect(first.ok).toBe(true);
    expect(second).toEqual({ ok: false, reason: 'unchanged' });
    expect(writesTo(h, 'd.md')).toHaveLength(1);
  });

  it('B4: duas tarefas da MESMA nota fechada ao mesmo tempo → 2 gravações em sequência, 0 avisos', async () => {
    const text = '- [ ] a\n- [ ] b\n';
    const h = await setup({ 'r.md': text });
    const catalog = await catalogFor(h);
    const changed = vi.spyOn(h.app.catalog, 'changed');
    const notices = h.app.store.getState().notices.length;
    h.port.resetCalls();
    const results = await Promise.all([
      catalog.toggleTask(ref('r.md', text, 0), { recordDoneDate: true }),
      catalog.toggleTask(ref('r.md', text, 1), { recordDoneDate: true }),
    ]);
    expect(results).toEqual([
      { ok: true, target: 'disk' },
      { ok: true, target: 'disk' },
    ]);
    expect(writesTo(h, 'r.md')).toHaveLength(2);
    expect(decode(h.port.readBytes('r.md'))).toBe('- [x] a ✅ 2026-10-10\n- [x] b ✅ 2026-10-10\n');
    expect(changed).not.toHaveBeenCalled();
    expect(h.app.store.getState().notices).toHaveLength(notices);
  });

  it('B2: ✅ sem data válida é texto do usuário — reabrir não o apaga; concluir grava a data', async () => {
    const closed = '- [x] Comprar ✅ leite\n';
    const open = '- [ ] Comprar ✅ leite\n';
    const h = await setup({ 'l.md': closed, 'k.md': open });
    const catalog = await catalogFor(h);
    expect(await catalog.toggleTask(ref('l.md', closed, 0), { recordDoneDate: true })).toEqual({
      ok: true,
      target: 'disk',
    });
    expect(decode(h.port.readBytes('l.md'))).toBe('- [ ] Comprar ✅ leite\n');

    expect(await catalog.toggleTask(ref('k.md', open, 0), { recordDoneDate: true })).toEqual({
      ok: true,
      target: 'disk',
    });
    const completed = decode(h.port.readBytes('k.md'));
    expect(completed).toBe('- [x] Comprar ✅ leite ✅ 2026-10-10\n');
    expect(parseTaskLine('- [x] Comprar ✅ leite ✅ 2026-10-10', 0)?.done).toBe('2026-10-10');
    // Reabrir de novo tira só o ✅ que a conclusão pôs: volta byte a byte ao texto do usuário.
    expect(await catalog.toggleTask(ref('k.md', completed, 0), { recordDoneDate: true })).toEqual({
      ok: true,
      target: 'disk',
    });
    expect(sha(h.port.readBytes('k.md')!)).toBe(sha(open));
  });

  it('sem pasta aberta / falha de leitura → io (aviso de erro)', async () => {
    const h = await setup({ 'e.md': '- [ ] a\n' });
    const catalog = await catalogFor(h);
    vi.spyOn(h.platform.vault, 'read').mockRejectedValueOnce(new Error('disco'));
    expect(await catalog.toggleTask(ref('e.md', '- [ ] a', 0), { recordDoneDate: true })).toEqual({
      ok: false,
      reason: 'io',
    });
    expect(h.app.store.getState().notices.at(-1)?.text).toBe(TASKS_CATALOG_TEXT.io);
    const closed = await setup({ 'e.md': '- [ ] a\n' }, { open: false });
    const none = await catalogFor(closed);
    expect(await none.editTask(ref('e.md', '- [ ] a', 0), () => ['x'])).toEqual({
      ok: false,
      reason: 'io',
    });
  });

  it('regra de repetição não suportada → marca + aviso STR-145 com a regra', async () => {
    const text = '- [ ] a 🔁 every 3rd tuesday\n';
    const h = await setup({ 'q.md': text });
    const catalog = await catalogFor(h);
    const result = await catalog.toggleTask(ref('q.md', text, 0), { recordDoneDate: false });
    expect(result).toEqual({ ok: true, target: 'disk', unsupportedRule: 'every 3rd tuesday' });
    expect(decode(h.port.readBytes('q.md'))).toBe('- [x] a 🔁 every 3rd tuesday\n');
    expect(h.app.store.getState().notices.at(-1)?.text).toBe(
      'Regra de repetição não suportada: “every 3rd tuesday”. A tarefa só foi marcada.',
    );
  });
});

describe('AC-I9.7 (VT) — editTask: alvo aberto → mudança no editor, 0 gravações diretas', () => {
  it('aba ativa: uma transação desfazível; dirty → autosave grava; Mod-Z volta', async () => {
    vi.useFakeTimers();
    const text = '# A\n- [ ] a\n';
    const h = await setup({ 'a.md': text });
    await h.app.sync.openFile('a.md');
    const view = mountActive(h, 'a.md');
    const catalog = await catalogFor(h, () => view);
    h.port.resetCalls();
    const result = await catalog.toggleTask(ref('a.md', text, 1), { recordDoneDate: true });
    expect(result).toEqual({ ok: true, target: 'editor' });
    expect(h.writes()).toBe(0);
    expect(view.state.doc.toString()).toBe('# A\n- [x] a ✅ 2026-10-10\n');
    expect(h.app.store.getState().docs['a.md']).toBe('dirty');
    await vi.advanceTimersByTimeAsync(1100);
    expect(decode(h.port.readBytes('a.md'))).toBe('# A\n- [x] a ✅ 2026-10-10\n');
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe(text);
  });

  it('aba aberta mas não ativa: o estado da aba muda (com histórico) e o autosave grava', async () => {
    vi.useFakeTimers();
    const text = '- [ ] b\n';
    const h = await setup({ 'a.md': '# A\n', 'b.md': text });
    await h.app.sync.openFile('b.md');
    await h.app.sync.openFile('a.md');
    const view = mountActive(h, 'a.md');
    const catalog = await catalogFor(h, () => view);
    h.port.resetCalls();
    expect(await catalog.toggleTask(ref('b.md', text, 0), { recordDoneDate: false })).toEqual({
      ok: true,
      target: 'editor',
    });
    expect(h.writes()).toBe(0);
    expect(h.text('b.md')).toBe('- [x] b\n');
    await vi.advanceTimersByTimeAsync(1100);
    expect(sha(h.port.readBytes('b.md')!)).toBe(sha('- [x] b\n'));
  });

  it('aba em conflito → 0 gravações + aviso STR-177 de conflito', async () => {
    const text = '- [ ] c\n';
    const h = await setup({ 'pasta/c.md': text });
    await h.app.sync.openFile('pasta/c.md');
    h.app.store.getState().setDocStatus('pasta/c.md', 'conflict');
    const catalog = await catalogFor(h);
    h.port.resetCalls();
    expect(await catalog.toggleTask(ref('pasta/c.md', text, 0), { recordDoneDate: true })).toEqual({
      ok: false,
      reason: 'conflict',
    });
    expect(h.writes()).toBe(0);
    expect(h.app.store.getState().notices.at(-1)?.text).toBe(
      '“c” está em conflito; resolva o conflito antes de marcar tarefas dela.',
    );
  });

  it('linha da aba não confere → changed (0 mudanças no editor); fora do documento → changed', async () => {
    const h = await setup({ 'a.md': '- [ ] a\n' });
    await h.app.sync.openFile('a.md');
    const view = mountActive(h, 'a.md');
    const catalog = await catalogFor(h, () => view);
    view.dispatch({ changes: { from: 6, insert: 'x' } });
    expect(await catalog.editTask(ref('a.md', '- [ ] a', 0), () => ['y'])).toEqual({
      ok: false,
      reason: 'changed',
    });
    const far: CatalogTaskRef = { path: 'a.md', task: { ...parseTaskLine('- [ ] a', 9)! } };
    expect(await catalog.editTask(far, () => ['y'])).toEqual({ ok: false, reason: 'changed' });
    expect(view.state.doc.toString()).toBe('- [ ] xa\n');
  });
});

describe('leitura: snapshot do índice v3, backlinks, wikilinks, abrir a origem', () => {
  it('snapshot ordenado com tarefas/propriedades; mesma identidade sem publicação nova', async () => {
    vi.useFakeTimers();
    const h = await setup(
      {
        'b.md': '---\ntipo: x\n---\n- [ ] tarefa #t\n[[a]]\n',
        'a.md': '# A\n',
        'pasta/c.md': '[ver](../a.md)\n',
      },
      { catalog: true },
    );
    // O extrator do índice chega por `import()` (NFR-54) antes do índice começar.
    for (let i = 0; i < 2000 && h.app.catalog.getSnapshot().status !== 'ready'; i++)
      await vi.advanceTimersByTimeAsync(1);
    const catalog = await catalogFor(h);
    const snap = catalog.getSnapshot();
    expect(snap.status).toBe('ready');
    expect(snap.notes.map((n) => n.path)).toEqual(['a.md', 'b.md', 'pasta/c.md']);
    const b = snap.notes[1]!;
    expect(b.tasks.map((t) => [t.line, t.text, t.tags])).toEqual([[3, 'tarefa #t', ['#t']]]);
    expect({ ...b.properties }).toEqual({ tipo: 'x' });
    expect(b.inlineTags).toEqual(['#t']);
    expect(catalog.getSnapshot()).toBe(snap);
    expect(catalog.backlinks('a.md')).toEqual(['b.md', 'pasta/c.md']);
    expect(catalog.resolveWikilink('pasta/c.md', 'a')).toBe('a.md');
    expect(catalog.resolveWikilink('b.md', 'nada')).toBeNull();
    expect(catalog.parseTaskLine('- [x] z ✅ 2026-10-01')?.done).toBe('2026-10-01');
    const listener = vi.fn();
    const off = catalog.subscribe(listener);
    h.app.catalog.saved('a.md', '# A2\n', Date.now() + 5000);
    expect(listener).toHaveBeenCalled();
    off();
  });

  it('openSource abre a aba e, quando ela aparece no editor, leva o cursor à linha; openNote abre', async () => {
    const h = await setup({ 'a.md': '# A\nl1\nl2\n- [ ] t\n', 'b.md': '# B\n' });
    let view: EditorView | null = null;
    const open = vi.spyOn(h.app.sync, 'openFile');
    const catalog = await catalogFor(h, () => view);
    catalog.openSource(ref('a.md', '# A\nl1\nl2\n- [ ] t', 3));
    await vi.waitFor(() => expect(h.app.registry.get('a.md')).toBeDefined());
    expect(open).toHaveBeenCalledWith('a.md');
    // A aba ainda não está no editor: espera quadros até ela aparecer.
    const shown = mountActive(h, 'a.md');
    view = shown;
    await vi.waitFor(() =>
      expect(shown.state.selection.main.head).toBe(shown.state.doc.line(4).from),
    );
    catalog.openNote('b.md');
    await vi.waitFor(() => expect(open).toHaveBeenCalledWith('b.md'));
  });
});
