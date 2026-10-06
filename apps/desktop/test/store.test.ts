import { describe, expect, test } from 'vitest';
import { createAppStore } from '../src/state/store';

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
