import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { AUTOSAVE_DEBOUNCE_MS, POLL_INTERVAL_MS } from '../src/state/sync';
import { setup } from './helpers';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
});
afterEach(() => {
  vi.useRealTimers();
});

const NOTA = '# Nota\n\nTexto.\n';
const COPY = 'nota (conflito 2026-10-06 09-30-00).md';

describe('autosave (R-2.9, NFR-11)', () => {
  test('AC-2.9: abrir um arquivo e esperar 10 s sem editar → 0 escritas', async () => {
    const h = await setup({ 'nota.md': NOTA });
    await h.app.sync.openFile('nota.md');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.writes()).toBe(0);
    expect(h.app.store.getState().docs['nota.md']).toBe('clean');
  });

  test('AC-2.10: 20 teclas a cada 300 ms → 0 escritas digitando e 1 escrita 1.000 ms após a última', async () => {
    const h = await setup({ 'nota.md': NOTA });
    await h.app.sync.openFile('nota.md');
    for (let i = 0; i < 20; i++) {
      h.type('nota.md', String.fromCharCode(97 + i));
      await vi.advanceTimersByTimeAsync(300);
    }
    expect(h.writes()).toBe(0);
    expect(h.app.store.getState().docs['nota.md']).toBe('dirty');
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS - 300 - 1);
    expect(h.writes()).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    await h.settle();
    expect(h.writes()).toBe(1);
    expect(h.port.readText('nota.md')).toBe(`${NOTA}abcdefghijklmnopqrst`);
    expect(h.app.store.getState().docs['nota.md']).toBe('clean');
  });

  test('cada salvamento passa a base de conteúdo (o provider recusa se o arquivo mudou, RR-03)', async () => {
    const h = await setup({ 'nota.md': NOTA });
    const write = vi.spyOn(h.platform.vault, 'write');
    const writeIfUnchanged = vi.spyOn(h.platform.vault, 'writeIfUnchanged');
    await h.app.sync.openFile('nota.md');
    const mtime = h.app.registry.get('nota.md')?.mtime;
    h.type('nota.md', 'x');
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    expect(write).not.toHaveBeenCalled();
    expect(writeIfUnchanged).toHaveBeenCalledOnce();
    expect(writeIfUnchanged).toHaveBeenCalledWith(
      expect.objectContaining({ root: '/vault' }),
      'nota.md',
      `${NOTA}x`,
      { text: NOTA, mtime },
    );
  });

  test('desfazer até o texto do disco não grava nada', async () => {
    const h = await setup({ 'nota.md': NOTA });
    await h.app.sync.openFile('nota.md');
    const original = h.app.registry.get('nota.md')!.state;
    h.type('nota.md', 'x');
    h.app.sync.onEditorChange('nota.md', original);
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.writes()).toBe(0);
    expect(h.app.store.getState().docs['nota.md']).toBe('clean');
  });

  test('R-2.5 pela store: CRLF + BOM preservados ao salvar uma edição', async () => {
    const raw = '\uFEFF# T\r\nlinha\r\n';
    const h = await setup({ 'win.md': raw });
    await h.app.sync.openFile('win.md');
    expect(h.text('win.md')).toBe('# T\nlinha\n');
    h.type('win.md', 'x');
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    expect(h.port.readText('win.md')).toBe('\uFEFF# T\r\nlinha\r\nx');
  });

  test('erro de E/S: novas tentativas em 1 s, 2 s e 4 s, depois estado de erro com aviso', async () => {
    const h = await setup({ 'nota.md': NOTA });
    await h.app.sync.openFile('nota.md');
    h.port.fault({ op: 'writeFile', error: 'IO' });
    h.type('nota.md', 'x');
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    expect(h.writes()).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.writes()).toBe(2);
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.writes()).toBe(3);
    expect(h.app.store.getState().docs['nota.md']).toBe('dirty');
    await vi.advanceTimersByTimeAsync(4000);
    expect(h.writes()).toBe(4);
    expect(h.app.store.getState().docs['nota.md']).toBe('error');
    const notice = h.app.store.getState().notices.at(-1);
    expect(notice).toMatchObject({ kind: 'error', notice: 'save-failed', detail: 'nota.md' });
    expect(h.text('nota.md')).toBe(`${NOTA}x`);
    h.port.clearFaults();
    notice?.action?.run();
    await h.settle();
    expect(h.app.store.getState().docs['nota.md']).toBe('clean');
    expect(h.port.readText('nota.md')).toBe(`${NOTA}x`);
  });
});

describe('AC-2.11: fechar aba e janela fazem exatamente 1 flush antes de fechar', () => {
  test('fechar aba suja: 1 escrita e a aba some', async () => {
    const h = await setup({ 'nota.md': NOTA });
    await h.app.sync.openFile('nota.md');
    h.type('nota.md', 'x');
    await expect(h.app.sync.closeTab('nota.md')).resolves.toBe('ok');
    expect(h.writes()).toBe(1);
    expect(h.port.readText('nota.md')).toBe(`${NOTA}x`);
    expect(h.app.store.getState().tabs).toEqual([]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.writes()).toBe(1);
  });

  test('fechar a janela com abas sujas: 1 escrita por aba e então a janela pode fechar', async () => {
    const h = await setup({ 'nota.md': NOTA, 'a.md': '# A\n' });
    await h.app.sync.openFile('nota.md');
    await h.app.sync.openFile('a.md');
    h.type('nota.md', '1');
    h.type('a.md', '2');
    await expect(h.requestClose()).resolves.toBe(true);
    expect(h.writes()).toBe(2);
    expect(h.port.readText('a.md')).toBe('# A\n2');
  });

  test('flush que falha mantém a aba (erro) e a janela aberta com L4; "Fechar sem salvar" fecha sem gravar', async () => {
    const h = await setup({ 'nota.md': NOTA });
    await h.app.sync.openFile('nota.md');
    h.type('nota.md', 'x');
    h.port.fault({ op: 'writeFile', error: 'PERMISSION_DENIED' });
    await expect(h.app.sync.closeTab('nota.md')).resolves.toBe('error');
    expect(h.app.store.getState().tabs).toHaveLength(1);
    expect(h.app.store.getState().notices.at(-1)?.text).toContain(
      'Sem permissão para gravar “nota.md”',
    );
    await expect(h.requestClose()).resolves.toBe(false);
    expect(h.app.store.getState().unsavedClose).toEqual({ reason: 'window', paths: ['nota.md'] });
    const writes = h.writes();
    await h.app.sync.discardAndClose();
    expect(h.platform.closeWindow).toHaveBeenCalledOnce();
    expect(h.writes()).toBe(writes);
    expect(h.port.readText('nota.md')).toBe(NOTA);
  });

  test('flush que cai em conflito: a aba fica e o diálogo aparece', async () => {
    const h = await setup({ 'nota.md': NOTA }, { watch: false });
    await h.app.sync.openFile('nota.md');
    h.type('nota.md', 'x');
    h.port.externalWrite('nota.md', 'externo\n');
    await expect(h.app.sync.closeTab('nota.md')).resolves.toBe('conflict');
    expect(h.app.store.getState().tabs).toHaveLength(1);
    expect(h.app.store.getState().conflict).toMatchObject({
      path: 'nota.md',
      reason: 'save-conflict',
    });
    await expect(h.requestClose()).resolves.toBe(false);
    expect(h.port.readText('nota.md')).toBe('externo\n');
  });
});

describe('AC-2.12: aba suja + mudança externa → conflito; "Manter ambos" nunca sobrescreve', () => {
  test('o diálogo aparece na hora (watch), mesmo digitando; Manter ambos cria a cópia e recarrega o original', async () => {
    const h = await setup({ 'nota.md': NOTA });
    await h.app.sync.openFile('nota.md');
    h.type('nota.md', 'meu texto');
    h.port.externalWrite('nota.md', 'externo\n');
    await h.settle();
    const state = h.app.store.getState();
    expect(state.conflict).toMatchObject({ path: 'nota.md', reason: 'external-change' });
    expect(state.docs['nota.md']).toBe('conflict');

    // Autosave pausado durante o conflito.
    h.type('nota.md', '!');
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.writes()).toBe(0);

    await h.app.sync.keepBoth();
    expect(h.port.readText('nota.md')).toBe('externo\n');
    expect(h.port.readText(COPY)).toBe(`${NOTA}meu texto!`);
    const after = h.app.store.getState();
    expect(after.conflict).toBeNull();
    expect(after.activeId).toBe(COPY);
    expect(after.tabs.map((t) => t.path)).toEqual(['nota.md', COPY]);
    expect(after.entries.map((e) => e.path)).toContain(COPY);
    expect(h.text('nota.md')).toBe('externo\n');
    expect(after.docs['nota.md']).toBe('clean');
    expect(after.notices.at(-1)).toMatchObject({ notice: 'conflict-copy-saved', detail: COPY });
    expect(
      h.port
        .calls()
        .filter((c) => c.op === 'writeFile')
        .map((c) => c.mode),
    ).toEqual(['create-new']);
  });

  test('nome de cópia já ocupado → variante " 2"; nada é sobrescrito', async () => {
    const h = await setup({ 'nota.md': NOTA, [COPY]: 'ocupado' });
    await h.app.sync.openFile('nota.md');
    h.type('nota.md', 'x');
    h.port.externalWrite('nota.md', 'externo\n');
    await h.settle();
    await h.app.sync.keepBoth();
    expect(h.port.readText(COPY)).toBe('ocupado');
    expect(h.port.readText('nota (conflito 2026-10-06 09-30-00) 2.md')).toBe(`${NOTA}x`);
  });

  test('conflito no salvamento: ConflictError → diálogo, disco intacto', async () => {
    const h = await setup({ 'nota.md': NOTA }, { watch: false });
    await h.app.sync.openFile('nota.md');
    h.port.externalWrite('nota.md', 'externo\n');
    h.type('nota.md', 'x');
    await expect(h.app.sync.flush('nota.md')).resolves.toBe('conflict');
    expect(h.app.store.getState().conflict?.reason).toBe('save-conflict');
    expect(h.port.readText('nota.md')).toBe('externo\n');
  });

  test('falha ao criar a cópia: diálogo continua, buffer e disco intactos (STR-21)', async () => {
    const h = await setup({ 'nota.md': NOTA });
    await h.app.sync.openFile('nota.md');
    h.type('nota.md', 'x');
    h.port.externalWrite('nota.md', 'externo\n');
    await h.settle();
    h.port.failNext('writeFile', 'PERMISSION_DENIED');
    await h.app.sync.keepBoth();
    expect(h.app.store.getState()).toMatchObject({ conflictFailed: true, conflictBusy: false });
    expect(h.app.store.getState().conflict).not.toBeNull();
    expect(h.text('nota.md')).toBe(`${NOTA}x`);
    expect(h.port.readText('nota.md')).toBe('externo\n');
  });

  test('"Recarregar do disco" descarta o buffer, 0 escritas', async () => {
    const h = await setup({ 'nota.md': NOTA });
    await h.app.sync.openFile('nota.md');
    h.type('nota.md', 'x');
    h.port.externalWrite('nota.md', 'externo\n');
    await h.settle();
    await h.app.sync.reloadFromDisk();
    expect(h.text('nota.md')).toBe('externo\n');
    expect(h.app.store.getState().docs['nota.md']).toBe('clean');
    expect(h.app.store.getState().notices.at(-1)?.notice).toBe('reloaded-from-disk');
    expect(h.writes()).toBe(0);
  });

  test('EC F-5: "Recarregar do disco" numa aba de fundo não troca a aba ativa', async () => {
    const h = await setup({ 'nota.md': NOTA, 'a.md': '# A\n' });
    await h.app.sync.openFile('nota.md');
    h.type('nota.md', 'bg');
    await h.app.sync.openFile('a.md');
    h.port.externalWrite('nota.md', 'ext\n');
    await h.settle();
    expect(h.app.store.getState().conflict?.path).toBe('nota.md');
    expect(h.app.store.getState().activeId).toBe('a.md');
    await h.app.sync.reloadFromDisk();
    expect(h.app.store.getState().activeId).toBe('a.md');
    expect(h.text('nota.md')).toBe('ext\n');
    expect(h.app.store.getState().docs['nota.md']).toBe('clean');
    expect(h.writes()).toBe(0);
  });

  test('conflitos em duas abas: um diálogo por vez, em ordem (FIFO)', async () => {
    const h = await setup({ 'nota.md': NOTA, 'a.md': '# A\n' });
    await h.app.sync.openFile('nota.md');
    await h.app.sync.openFile('a.md');
    h.type('nota.md', 'x');
    h.type('a.md', 'y');
    h.port.externalWrite('nota.md', 'e1\n');
    h.port.externalWrite('a.md', 'e2\n');
    await h.settle();
    expect(h.app.store.getState().conflict?.path).toBe('nota.md');
    await h.app.sync.reloadFromDisk();
    expect(h.app.store.getState().conflict?.path).toBe('a.md');
  });
});

describe('AC-2.13: aba limpa + mudança externa → recarrega e avisa, 0 escritas', () => {
  test('com watch', async () => {
    const h = await setup({ 'nota.md': NOTA });
    await h.app.sync.openFile('nota.md');
    h.port.externalWrite('nota.md', 'novo conteúdo\n');
    await h.settle();
    expect(h.text('nota.md')).toBe('novo conteúdo\n');
    expect(h.app.store.getState().notices.at(-1)).toMatchObject({
      kind: 'info',
      notice: 'external-reload',
      text: 'Arquivo alterado fora do simpleMD; recarregado',
      detail: 'nota.md',
    });
    expect(h.writes()).toBe(0);
  });

  test('sem watch: a sondagem detecta em ≤ 1.000 ms (NFR-12)', async () => {
    const h = await setup({ 'nota.md': NOTA }, { watch: false });
    await h.app.sync.openFile('nota.md');
    h.port.externalWrite('nota.md', 'sondado\n');
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    await h.settle();
    expect(h.text('nota.md')).toBe('sondado\n');
    expect(h.writes()).toBe(0);
  });

  test('só o mtime mudou (R-2.6): nada recarrega e o próximo salvamento passa', async () => {
    const h = await setup({ 'nota.md': NOTA });
    await h.app.sync.openFile('nota.md');
    h.port.touch('nota.md');
    await h.settle();
    expect(h.app.store.getState().notices).toEqual([]);
    h.type('nota.md', 'x');
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    expect(h.app.store.getState().conflict).toBeNull();
    expect(h.port.readText('nota.md')).toBe(`${NOTA}x`);
  });

  test('foco da janela confere as abas abertas', async () => {
    const h = await setup({ 'nota.md': NOTA }, { watch: false });
    await h.app.sync.openFile('nota.md');
    h.port.externalWrite('nota.md', 'foco\n');
    h.app.sync.onWindowFocus();
    await h.settle();
    expect(h.text('nota.md')).toBe('foco\n');
  });
});

describe('arquivo removido fora do app', () => {
  test('aba limpa: fecha com aviso, 0 escritas', async () => {
    const h = await setup({ 'nota.md': NOTA, 'a.md': '' });
    await h.app.sync.openFile('nota.md');
    h.port.remove('nota.md');
    await h.settle();
    expect(h.app.store.getState().tabs).toEqual([]);
    expect(h.app.store.getState().notices.at(-1)).toMatchObject({
      notice: 'deleted',
      detail: 'nota.md',
    });
    expect(h.app.store.getState().entries.map((e) => e.path)).toEqual(['a.md']);
    expect(h.writes()).toBe(0);
  });

  test('aba suja: conflito "deleted"; Manter ambos cria a cópia e não recria o original', async () => {
    const h = await setup({ 'nota.md': NOTA });
    await h.app.sync.openFile('nota.md');
    h.type('nota.md', 'x');
    h.port.remove('nota.md');
    await h.settle();
    expect(h.app.store.getState().conflict?.reason).toBe('deleted');
    await h.app.sync.keepBoth();
    expect(h.port.readText('nota.md')).toBeNull();
    expect(h.port.readText(COPY)).toBe(`${NOTA}x`);
    expect(h.app.store.getState().tabs.map((t) => t.path)).toEqual([COPY]);
  });
});

describe('abrir pasta e arquivos', () => {
  test('arquivo que não é UTF-8: nenhuma aba, aviso de erro, 0 escritas', async () => {
    const h = await setup({ 'latin1.md': new Uint8Array([0x63, 0xe9, 0x0a]) });
    await expect(h.app.sync.openFile('latin1.md')).resolves.toBe(false);
    expect(h.app.store.getState().tabs).toEqual([]);
    expect(h.app.store.getState().notices.at(-1)).toMatchObject({
      kind: 'error',
      notice: 'not-utf8',
    });
    expect(h.writes()).toBe(0);
  });

  test('arquivo com finais de linha mistos: aviso único ao abrir, sem gravar', async () => {
    const h = await setup({ 'misto.md': 'a\r\nb\nc\r\n' });
    await h.app.sync.openFile('misto.md');
    expect(h.app.store.getState().notices.at(-1)?.notice).toBe('mixed-eol');
    expect(h.writes()).toBe(0);
  });

  test('primeira listagem negada vinda das boas-vindas → volta às boas-vindas com o alerta', async () => {
    const h = await setup({ 'nota.md': NOTA }, { open: false });
    h.port.fault({ op: 'readDir', error: 'PERMISSION_DENIED' });
    await h.app.sync.openVault('welcome');
    expect(h.app.store.getState()).toMatchObject({
      vaultStatus: 'closed',
      welcomeError: { kind: 'denied' },
    });
    h.port.clearFaults();
    h.port.fault({ op: 'readDir', error: 'IO', once: true });
    await h.app.sync.openVault('welcome');
    expect(h.app.store.getState().welcomeError).toEqual({ kind: 'io', folder: 'vault' });
    await h.app.sync.openVault('welcome');
    expect(h.app.store.getState()).toMatchObject({
      vaultStatus: 'open',
      welcomeError: null,
      listStatus: 'ready',
    });
  });

  test('trocar de pasta faz flush das abas e fecha as do vault anterior', async () => {
    const h = await setup({ 'nota.md': NOTA });
    await h.app.sync.openFile('nota.md');
    h.type('nota.md', 'x');
    await h.app.sync.openVault('shell');
    expect(h.port.readText('nota.md')).toBe(`${NOTA}x`);
    expect(h.app.store.getState().tabs).toEqual([]);
    expect(h.app.store.getState().listStatus).toBe('ready');
  });

  test('cancelar o diálogo de pasta não muda nada', async () => {
    const h = await setup({ 'nota.md': NOTA });
    await h.app.sync.openFile('nota.md');
    h.port.setPickDirectory(() => null);
    await h.app.sync.openVault('shell');
    expect(h.app.store.getState().tabs).toHaveLength(1);
    expect(h.app.store.getState().opening).toBe(false);
  });
});

describe('"Nova nota" (L8): só-criação, nunca sobrescreve', () => {
  test('cria a nota vazia na pasta do item focado, revela no explorador e abre na aba', async () => {
    const h = await setup({ 'nota.md': NOTA, 'sub/a.md': '# A\n' });
    h.app.store.getState().setFocused('sub/a.md');
    h.app.sync.openNewNote();
    expect(h.app.store.getState().newNote).toEqual({ folder: 'sub', error: null, busy: false });
    await expect(h.app.sync.createNote('sub', '  Ideias  ')).resolves.toBe(true);
    const s = h.app.store.getState();
    expect(s.newNote).toBeNull();
    expect(h.port.readText('sub/Ideias.md')).toBe('');
    expect(s.activeId).toBe('sub/Ideias.md');
    expect(s.docs['sub/Ideias.md']).toBe('clean');
    expect(s.entries.map((e) => e.path)).toContain('sub/Ideias.md');
    expect(s.expanded).toMatchObject({ sub: true });
    expect(s.focusedPath).toBe('sub/Ideias.md');
    expect(
      h.port
        .calls()
        .filter((c) => c.op === 'writeFile')
        .map((c) => c.mode),
    ).toEqual(['create-new']);
  });

  test('nome já usado: alerta no L8, 0 gravações e o arquivo existente intacto', async () => {
    const h = await setup({ 'nota.md': NOTA });
    h.app.sync.openNewNote();
    await expect(h.app.sync.createNote('', 'nota')).resolves.toBe(false);
    expect(h.app.store.getState().newNote).toEqual({
      folder: '',
      error: 'Já existe “nota.md” nesta pasta.',
      busy: false,
    });
    expect(h.writes()).toBe(0);
    expect(h.port.readText('nota.md')).toBe(NOTA);
    expect(h.app.store.getState().tabs).toEqual([]);
  });

  test.each([
    ['', 'Digite um nome para a nota.'],
    ['a/b', 'O nome não pode ter estes caracteres: / \\ : * ? " < > |'],
    ['o quê?', 'O nome não pode ter estes caracteres: / \\ : * ? " < > |'],
    ['.oculta', 'O nome não pode começar com ponto.'],
    ['CON', 'Este nome não pode ser usado.'],
  ])('nome "%s" recusado antes de tocar o disco', async (name, error) => {
    const h = await setup({ 'nota.md': NOTA });
    h.app.sync.openNewNote();
    await expect(h.app.sync.createNote('', name)).resolves.toBe(false);
    expect(h.app.store.getState().newNote?.error).toBe(error);
    expect(h.writes()).toBe(0);
  });

  test('falha ao gravar: alerta, o L8 continua aberto e a nova tentativa cria', async () => {
    const h = await setup({ 'nota.md': NOTA });
    h.app.sync.openNewNote();
    h.port.failNext('writeFile', 'PERMISSION_DENIED');
    await expect(h.app.sync.createNote('', 'nova')).resolves.toBe(false);
    expect(h.app.store.getState().newNote).toEqual({
      folder: '',
      error: 'Sem permissão para criar a nota nesta pasta.',
      busy: false,
    });
    expect(h.port.readText('nova.md')).toBeNull();
    await expect(h.app.sync.createNote('', 'nova')).resolves.toBe(true);
    expect(h.port.readText('nova.md')).toBe('');
  });
});
