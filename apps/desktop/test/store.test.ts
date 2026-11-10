import { describe, expect, test } from 'vitest';
import { createAppStore, type AppStore } from '../src/state/store';
import { setup } from './helpers';

describe('AC-2.17: transições da store', () => {
  test('abrir, focar a aba existente, ativar e fechar', () => {
    const store = createAppStore();
    const s = () => store.getState();
    expect(s().addTab('a.md')).toBe(true);
    expect(s().addTab('sub/b.md')).toBe(true);
    expect(s().addTab('c.md')).toBe(true);
    expect(s().tabs.map((t) => t.name)).toEqual(['a.md', 'b.md', 'c.md']);
    expect(s().activeId).toBe('c.md');
    expect(s().docs['sub/b.md']).toBe('loading');

    // Reabrir um arquivo já aberto só o foca: continuam 3 abas (AC-2.15).
    expect(s().addTab('a.md')).toBe(false);
    expect(s().tabs).toHaveLength(3);
    expect(s().activeId).toBe('a.md');

    s().activate('sub/b.md');
    expect(s().activeId).toBe('sub/b.md');
    s().activate('inexistente.md');
    expect(s().activeId).toBe('sub/b.md');

    // Fechar a ativa ativa a vizinha da direita; na ponta, a da esquerda.
    s().removeTab('sub/b.md');
    expect(s().activeId).toBe('c.md');
    expect(s().docs).not.toHaveProperty('sub/b.md');
    s().removeTab('c.md');
    expect(s().activeId).toBe('a.md');
    s().removeTab('a.md');
    expect(s().activeId).toBeNull();
    expect(s().tabs).toEqual([]);
  });

  test('fechar uma aba inativa mantém a ativa; Ctrl-Tab percorre com volta', () => {
    const store = createAppStore();
    const s = () => store.getState();
    s().addTab('a.md');
    s().addTab('b.md');
    s().addTab('c.md');
    s().removeTab('a.md');
    expect(s().activeId).toBe('c.md');
    s().activateSibling(1);
    expect(s().activeId).toBe('b.md');
    s().activateSibling(-1);
    expect(s().activeId).toBe('c.md');
  });

  test('markDirty/markSaved: só muda em transição real (sem atualização por tecla)', () => {
    const store = createAppStore();
    const s = () => store.getState();
    s().addTab('a.md');
    s().markDirty('a.md');
    expect(s().docs['a.md']).toBe('loading'); // ainda carregando: nada a marcar
    s().setDocStatus('a.md', 'clean');
    let updates = 0;
    const stop = store.subscribe(() => updates++);
    s().markDirty('a.md');
    s().markDirty('a.md');
    s().markDirty('a.md');
    expect(s().docs['a.md']).toBe('dirty');
    expect(updates).toBe(1);
    s().setDocStatus('a.md', 'saving');
    s().markDirty('a.md');
    expect(s().docs['a.md']).toBe('saving');
    s().setDocStatus('a.md', 'clean');
    s().setDocStatus('a.md', 'error');
    s().markDirty('a.md');
    expect(s().docs['a.md']).toBe('dirty');
    s().setDocStatus('fechada.md', 'dirty');
    expect(s().docs).not.toHaveProperty('fechada.md');
    stop();
  });

  test('conflitos: um por vez, FIFO, sem duplicar a mesma aba', () => {
    const store = createAppStore();
    const s = () => store.getState();
    s().raiseConflict({ tabId: 'a.md', path: 'a.md', reason: 'external-change' });
    s().raiseConflict({ tabId: 'b.md', path: 'b.md', reason: 'deleted' });
    s().raiseConflict({ tabId: 'a.md', path: 'a.md', reason: 'save-conflict' });
    s().raiseConflict({ tabId: 'b.md', path: 'b.md', reason: 'save-conflict' });
    expect(s().conflict).toMatchObject({ tabId: 'a.md', reason: 'external-change' });
    expect(s().conflictQueue.map((c) => c.tabId)).toEqual(['b.md']);
    store.setState({ conflictFailed: true, conflictBusy: true });
    s().resolveConflict();
    expect(s()).toMatchObject({
      conflict: { tabId: 'b.md', reason: 'deleted' },
      conflictFailed: false,
      conflictBusy: false,
    });
    s().resolveConflict();
    expect(s().conflict).toBeNull();
    s().raiseConflict({ tabId: 'a.md', path: 'a.md', reason: 'external-change' });
    expect(s().conflict?.id).not.toBe('conflict-1');
  });

  test('avisos: no máximo 3, sai o informativo mais antigo; chave substitui', () => {
    const store = createAppStore();
    const s = () => store.getState();
    s().pushNotice({ kind: 'error', notice: 'save-failed', text: 'e1', key: 'save-failed:a.md' });
    s().pushNotice({ kind: 'info', notice: 'external-reload', text: 'i1' });
    s().pushNotice({ kind: 'info', notice: 'external-reload', text: 'i2' });
    s().pushNotice({ kind: 'info', notice: 'deleted', text: 'i3' });
    expect(s().notices.map((n) => n.text)).toEqual(['e1', 'i2', 'i3']);
    s().pushNotice({ kind: 'error', notice: 'save-failed', text: 'e1b', key: 'save-failed:a.md' });
    expect(s().notices.map((n) => n.text)).toEqual(['i2', 'i3', 'e1b']);
    s().dismissNotice(s().notices[0]!.id);
    expect(s().notices.map((n) => n.text)).toEqual(['i3', 'e1b']);
  });

  test('explorador: alternar pasta e expandir tudo', () => {
    const store = createAppStore();
    const s = () => store.getState();
    store.setState({
      entries: [
        { path: 'a', name: 'a', kind: 'dir' },
        { path: 'a/b', name: 'b', kind: 'dir' },
        { path: 'a/b/c.md', name: 'c.md', kind: 'file' },
      ],
    });
    s().toggleFolder('a');
    expect(s().expanded).toEqual({ a: true });
    s().toggleFolder('a');
    expect(s().expanded).toEqual({});
    s().expandAll();
    expect(s().expanded).toEqual({ a: true, 'a/b': true });
  });
});

/** Abas de cada grupo, na ordem, e o resto do estado dos grupos; confere o espelho `activeId`. */
function groups(store: AppStore) {
  const s = store.getState();
  expect(s.activeId).toBe(s.groupActive[s.focusedGroup]);
  return {
    left: s.tabs.filter((tab) => tab.group === 0).map((tab) => tab.id),
    right: s.tabs.filter((tab) => tab.group === 1).map((tab) => tab.id),
    active: s.groupActive,
    focused: s.focusedGroup,
    split: s.split,
  };
}

describe('r39a — dois grupos do editor na store (D-R39-01..04)', () => {
  test('sem divisão: tudo no grupo 0 com o foco; dividir pede uma aba aberta', () => {
    const store = createAppStore();
    const s = () => store.getState();
    expect(s().splitEditor()).toBe(false);
    s().addTab('a.md');
    s().addTab('b.md');
    s().focusGroup(1);
    expect(groups(store)).toEqual({
      left: ['a.md', 'b.md'],
      right: [],
      active: ['b.md', null],
      focused: 0,
      split: false,
    });
  });

  test('dividir: direita vazia com o foco; aba nova no grupo com foco; aberta foca o grupo dela', () => {
    const store = createAppStore();
    const s = () => store.getState();
    s().addTab('a.md');
    s().addTab('b.md');
    expect(s().splitEditor()).toBe(true);
    expect(s().splitEditor()).toBe(false);
    expect(groups(store)).toEqual({
      left: ['a.md', 'b.md'],
      right: [],
      active: ['b.md', null],
      focused: 1,
      split: true,
    });
    expect(s().addTab('c.md')).toBe(true);
    expect(groups(store)).toMatchObject({ right: ['c.md'], active: ['b.md', 'c.md'], focused: 1 });
    // Regra 2: a nota já aberta à esquerda não abre de novo; a aba dela fica ativa e com o foco.
    expect(s().addTab('a.md')).toBe(false);
    expect(s().tabs).toHaveLength(3);
    expect(groups(store)).toMatchObject({ active: ['a.md', 'c.md'], focused: 0 });
    s().activate('c.md');
    expect(groups(store)).toMatchObject({ active: ['a.md', 'c.md'], focused: 1 });
    s().focusGroup(0);
    expect(s().activeId).toBe('a.md');
  });

  test('Ctrl-Tab e fechar agem no grupo da aba; a vizinha é do mesmo grupo', () => {
    const store = createAppStore();
    const s = () => store.getState();
    for (const path of ['a.md', 'b.md', 'c.md']) s().addTab(path);
    s().splitEditor();
    s().addTab('x.md');
    s().addTab('y.md');
    s().activateSibling(1);
    expect(groups(store)).toMatchObject({ active: ['c.md', 'x.md'], focused: 1 });
    s().activateSibling(-1);
    expect(s().activeId).toBe('y.md');
    // A ativa do grupo sem foco fecha: a vizinha da esquerda, no grupo dela; o foco não muda.
    s().removeTab('c.md');
    expect(groups(store)).toMatchObject({ left: ['a.md', 'b.md'], active: ['b.md', 'y.md'] });
    expect(s().activeId).toBe('y.md');
    s().activate('a.md');
    s().removeTab('a.md');
    expect(groups(store)).toMatchObject({ left: ['b.md'], active: ['b.md', 'y.md'], focused: 0 });
    expect(s().docs).not.toHaveProperty('a.md');
  });

  test('juntar: abas do grupo mantido primeiro, todas no grupo 0; ativa = a do mantido ou a do outro', () => {
    const store = createAppStore();
    const s = () => store.getState();
    s().addTab('a.md');
    s().addTab('b.md');
    s().splitEditor();
    s().addTab('x.md');
    s().addTab('y.md');
    s().activate('x.md');
    s().mergeGroups(1);
    expect(groups(store)).toEqual({
      left: ['x.md', 'y.md', 'a.md', 'b.md'],
      right: [],
      active: ['x.md', null],
      focused: 0,
      split: false,
    });
    s().mergeGroups(1);
    expect(groups(store).left).toEqual(['x.md', 'y.md', 'a.md', 'b.md']);
    // Mantido o grupo vazio (direita recém-dividida): a ativa é a do outro.
    s().splitEditor();
    s().mergeGroups(1);
    expect(groups(store)).toMatchObject({ active: ['x.md', null], focused: 0, split: false });
  });

  test('dividido, fechar a última aba de um grupo junta as abas no outro', () => {
    const store = createAppStore();
    const s = () => store.getState();
    s().addTab('a.md');
    s().addTab('b.md');
    s().splitEditor();
    s().addTab('x.md');
    s().removeTab('x.md');
    expect(groups(store)).toEqual({
      left: ['a.md', 'b.md'],
      right: [],
      active: ['b.md', null],
      focused: 0,
      split: false,
    });
    s().splitEditor();
    s().addTab('x.md');
    s().addTab('y.md');
    s().removeTab('a.md');
    s().removeTab('b.md');
    expect(groups(store)).toEqual({
      left: ['x.md', 'y.md'],
      right: [],
      active: ['y.md', null],
      focused: 0,
      split: false,
    });
    expect(Object.keys(s().docs)).toEqual(['x.md', 'y.md']);
  });

  test('trocar de pasta zera a divisão, o foco e as ativas dos grupos (sync)', async () => {
    const h = await setup({ 'a.md': '# A\n', 'b.md': '# B\n' });
    await h.app.sync.openFile('a.md');
    h.app.store.getState().splitEditor();
    await h.app.sync.openFile('b.md');
    expect(h.app.store.getState()).toMatchObject({
      split: true,
      focusedGroup: 1,
      groupActive: ['a.md', 'b.md'],
      activeId: 'b.md',
    });
    await h.app.sync.openVault('welcome');
    expect(h.app.store.getState()).toMatchObject({
      vaultStatus: 'open',
      tabs: [],
      activeId: null,
      groupActive: [null, null],
      split: false,
      focusedGroup: 0,
    });
  });
});
