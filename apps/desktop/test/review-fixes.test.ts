import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { AUTOSAVE_DEBOUNCE_MS } from '../src/state/sync';
import { setup } from './helpers';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
});
afterEach(() => {
  vi.useRealTimers();
});

/** Finais de linha que o app precisa respeitar ao fechar sem editar (regra 1). */
const LINE_ENDINGS = [
  { name: 'LF', raw: 'a\nb\nc\n' },
  { name: 'CRLF + BOM', raw: '\uFEFFa\r\nb\r\nc\r\n' },
  { name: 'misto', raw: 'a\r\nb\nc\r\n' },
  { name: 'só CR', raw: 'a\rb\rc\r' },
];

describe('CR-01: uma aba limpa nunca é gravada (fechar aba, fechar janela, trocar de pasta)', () => {
  test.each(LINE_ENDINGS)('R1 fechar aba — $name', async ({ raw }) => {
    const h = await setup({ 'f.md': raw });
    await h.app.sync.openFile('f.md');
    await expect(h.app.sync.closeTab('f.md')).resolves.toBe('ok');
    await h.settle();
    expect(h.writes()).toBe(0);
    expect(h.port.readText('f.md')).toBe(raw);
  });

  test.each(LINE_ENDINGS)('R2 fechar janela — $name', async ({ raw }) => {
    const h = await setup({ 'f.md': raw });
    await h.app.sync.openFile('f.md');
    await expect(h.requestClose()).resolves.toBe(true);
    await h.settle();
    expect(h.writes()).toBe(0);
    expect(h.port.readText('f.md')).toBe(raw);
  });

  test.each(LINE_ENDINGS)('trocar de pasta — $name', async ({ raw }) => {
    const h = await setup({ 'f.md': raw });
    await h.app.sync.openFile('f.md');
    await h.app.sync.openVault('shell');
    await h.settle();
    expect(h.writes()).toBe(0);
    expect(h.port.readText('f.md')).toBe(raw);
  });

  test('editar e desfazer até o original num arquivo misto não grava', async () => {
    const raw = 'a\r\nb\nc\r\n';
    const h = await setup({ 'f.md': raw });
    await h.app.sync.openFile('f.md');
    const original = h.app.registry.get('f.md')!.state;
    h.type('f.md', 'x');
    h.app.sync.onEditorChange('f.md', original);
    await vi.advanceTimersByTimeAsync(5000);
    await h.app.sync.closeTab('f.md');
    expect(h.writes()).toBe(0);
  });

  test('editar um arquivo só-CR mantém CR (CR-05: sem conversão silenciosa)', async () => {
    const h = await setup({ 'f.md': 'a\rb\r' });
    await h.app.sync.openFile('f.md');
    expect(h.text('f.md')).toBe('a\nb\n');
    expect(h.app.store.getState().notices.map((n) => n.notice)).not.toContain('mixed-eol');
    h.type('f.md', 'c');
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    expect(h.port.readText('f.md')).toBe('a\rb\rc');
  });

  test('depois de um salvamento, fechar sem nova edição não grava de novo', async () => {
    const h = await setup({ 'f.md': 'a\r\nb\nc\r\n' });
    await h.app.sync.openFile('f.md');
    h.type('f.md', 'x');
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    expect(h.writes()).toBe(1);
    await h.app.sync.closeTab('f.md');
    expect(h.writes()).toBe(1);
  });
});

describe('CR-03: tecla que chega durante o flush de fechar a aba', () => {
  test('R3: é gravada antes de a aba fechar', async () => {
    const h = await setup({ 'nota.md': '# N\n' });
    await h.app.sync.openFile('nota.md');
    h.type('nota.md', 'x');
    h.port.fault({ op: 'writeFile', delayMs: 50, once: true });
    const closing = h.app.sync.closeTab('nota.md');
    await vi.advanceTimersByTimeAsync(10);
    h.type('nota.md', 'y');
    await vi.advanceTimersByTimeAsync(100);
    await expect(closing).resolves.toBe('ok');
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.port.readText('nota.md')).toBe('# N\nxy');
    expect(h.app.store.getState().tabs).toEqual([]);
  });

  test('o mesmo ao fechar a janela', async () => {
    const h = await setup({ 'nota.md': '# N\n' });
    await h.app.sync.openFile('nota.md');
    h.type('nota.md', 'x');
    h.port.fault({ op: 'writeFile', delayMs: 50, once: true });
    const closing = h.requestClose();
    await vi.advanceTimersByTimeAsync(10);
    h.type('nota.md', 'y');
    await vi.advanceTimersByTimeAsync(100);
    await expect(closing).resolves.toBe(true);
    expect(h.port.readText('nota.md')).toBe('# N\nxy');
  });
});

describe('CR-02: digitar com o diálogo "Abrir pasta…" aberto', () => {
  test('R4: o texto é gravado antes de trocar de pasta', async () => {
    const h = await setup({ 'nota.md': '# N\n' });
    await h.app.sync.openFile('nota.md');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const open = h.platform.vault.open.bind(h.platform.vault);
    h.platform.vault.open = async () => {
      await gate;
      return open();
    };
    const switching = h.app.sync.openVault('shell');
    await vi.advanceTimersByTimeAsync(10);
    h.type('nota.md', 'typed-during-dialog');
    release();
    await switching;
    await vi.advanceTimersByTimeAsync(3000);
    expect(h.port.readText('nota.md')).toBe('# N\ntyped-during-dialog');
  });

  test('se essa gravação falhar, a pasta não troca e L4 aparece; "Fechar sem salvar" troca sem gravar', async () => {
    const h = await setup({ 'nota.md': '# N\n' });
    await h.app.sync.openFile('nota.md');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const open = h.platform.vault.open.bind(h.platform.vault);
    h.platform.vault.open = async () => {
      await gate;
      return open();
    };
    const switching = h.app.sync.openVault('shell');
    await vi.advanceTimersByTimeAsync(10);
    h.type('nota.md', 'x');
    h.port.fault({ op: 'writeFile', error: 'PERMISSION_DENIED' });
    release();
    await switching;
    expect(h.app.store.getState()).toMatchObject({
      opening: false,
      unsavedClose: { reason: 'vault-switch', paths: ['nota.md'] },
    });
    expect(h.app.store.getState().tabs).toHaveLength(1);
    const writes = h.writes();
    h.platform.vault.open = open;
    await h.app.sync.discardAndClose();
    expect(h.writes()).toBe(writes);
    expect(h.app.store.getState().tabs).toEqual([]);
    expect(h.port.readText('nota.md')).toBe('# N\n');
  });
});

describe('CR-07 / CR-12', () => {
  test('o autosave de um arquivo aberto não relê o vault inteiro', async () => {
    const h = await setup({ 'nota.md': '# N\n', 'outra.md': '' });
    await h.app.sync.openFile('nota.md');
    h.port.resetCalls();
    h.type('nota.md', 'x');
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    // O observador nativo também relata a gravação do próprio app (mesmos bytes).
    h.port.externalWrite('nota.md', h.port.readText('nota.md')!);
    await h.settle();
    expect(h.port.calls().filter((c) => c.op === 'readDir')).toEqual([]);
    h.port.externalWrite('nova.md', '');
    await h.settle();
    expect(h.app.store.getState().entries.map((e) => e.path)).toContain('nova.md');
  });

  test('falha inesperada ao abrir a pasta não deixa "Abrir pasta…" travado', async () => {
    const h = await setup({ 'nota.md': '' }, { open: false });
    const open = h.platform.vault.open.bind(h.platform.vault);
    h.platform.vault.open = async () => {
      const handle = await open();
      return {
        ...handle,
        get name(): string {
          throw new Error('inesperado');
        },
      };
    };
    await expect(h.app.sync.openVault('welcome')).rejects.toThrow('inesperado');
    expect(h.app.store.getState().opening).toBe(false);
    h.platform.vault.open = open;
    await h.app.sync.openVault('welcome');
    expect(h.app.store.getState().vaultStatus).toBe('open');
  });
});
