// @vitest-environment jsdom
import { undo } from '@codemirror/commands';
import { StateEffect } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { AI_PROMPTS } from '@simplemd/ai';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { PREFS_SAVE_DEBOUNCE_MS } from '../src/state/settings';
import { setup, type Harness } from './helpers';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
});
afterEach(() => {
  vi.useRealTimers();
});

const CONFIG = '.simplemd/config.json';
const CANARY = `sk-test-CANARY-${Math.random().toString(36).slice(2, 10)}`;

// O jsdom não mede texto: o CodeMirror só precisa de listas vazias para não lançar no rAF.
Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => new DOMRect();

/**
 * Abre a nota e monta um `EditorView` real ligado ao editor principal; as mudanças vão para a IA
 * como no `onChange` do app (mapeamento da faixa do cartão).
 */
async function withEditor(h: Harness, path: string) {
  await h.app.sync.openFile(path);
  const base = h.app.plugins.editor.refresh(h.app.registry.get(path)!.state);
  const state = base.update({
    effects: StateEffect.appendConfig.of(
      EditorView.updateListener.of((update) => h.app.ai.onEditorChange(path, update)),
    ),
  }).state;
  const view = new EditorView({ state, parent: document.createElement('div') });
  h.app.plugins.editor.attach(view);
  return view;
}

function useOllama(h: Harness) {
  h.app.settings.setAi({ provider: 'ollama', models: { ollama: 'qwen3.5:9b' } });
}

async function drain() {
  for (let i = 0; i < 50; i++) await vi.advanceTimersByTimeAsync(20);
}

describe('AC-11.14 nenhum tráfego sem ação explícita', () => {
  test('abrir a pasta, digitar 200 caracteres, plugins e Configurações → 0 chamadas', async () => {
    const h = await setup({ 'nota.md': '# Nota\n' });
    await h.app.sync.openFile('nota.md');
    h.type('nota.md', 'x'.repeat(200));
    h.app.store.setState({ settingsOpen: true, settingsSection: 'ai' });
    await h.app.ai.refreshKeys();
    useOllama(h);
    await drain();
    expect(h.ai.calls()).toEqual([]);
  });
});

describe('AC-11.10 / AC-11.6 configuração e canária (keychain falso)', () => {
  test('config.json.ai só com provedor/modelos/endereço/idioma; a canária não aparece em lugar nenhum', async () => {
    const h = await setup({ 'nota.md': '# Nota\n', [CONFIG]: '{"x":1}' });
    h.app.settings.setAi({ provider: 'openai', models: { openai: 'gpt-4o-mini' } });
    expect(await h.app.ai.saveKey('openai', CANARY)).toBe(true);
    expect(h.ai.keychain.has('openai')).toBe(true);
    expect(h.app.ai.getSnapshot().keys.openai).toBe('saved');
    expect(h.app.ai.getSnapshot().live).toBe('Chave salva');
    await vi.advanceTimersByTimeAsync(PREFS_SAVE_DEBOUNCE_MS);
    await h.settle();
    const saved = JSON.parse(h.port.readText(CONFIG) ?? '{}');
    expect(saved.x).toBe(1);
    expect(saved.ai).toEqual({
      provider: 'openai',
      models: { openai: 'gpt-4o-mini' },
      ollamaUrl: 'http://127.0.0.1:11434',
      language: 'en',
    });
    expect(JSON.stringify(saved.ai)).not.toMatch(/key|chave/i);
    // Canária: 0 ocorrências em todo arquivo do vault (inclui .simplemd), no store e no estado da IA.
    for (const [, latin1] of h.port.snapshot().files) expect(latin1).not.toContain('CANARY');
    expect(JSON.stringify(h.app.store.getState())).not.toContain('CANARY');
    expect(JSON.stringify(h.app.ai.getSnapshot())).not.toContain('CANARY');
    await h.app.ai.removeKey('openai');
    expect(h.app.ai.getSnapshot().keys.openai).toBe('none');
  });

  test('falha do keychain → texto STR-125 fixo, sem o valor', async () => {
    const h = await setup({ 'nota.md': '' });
    h.ai.keychain.fail('KEYCHAIN_DENIED');
    expect(await h.app.ai.saveKey('anthropic', CANARY)).toBe(false);
    const error = h.app.ai.getSnapshot().keyErrors.anthropic;
    expect(error).toBe('Acesso ao keychain negado. A chave não foi salva.');
    expect(h.ai.keychain.has('anthropic')).toBe(false);
  });

  test('"Atualizar lista" é a única origem de listModels; endereço fora do loopback não é gravado', async () => {
    const h = await setup({ 'nota.md': '' });
    useOllama(h);
    expect(h.ai.calls()).toHaveLength(0);
    await h.app.ai.refreshModels();
    expect(h.app.ai.getSnapshot().models).toMatchObject({ state: 'ok', provider: 'ollama' });
    expect(h.ai.calls().map((c) => `${c.method} ${c.path}`)).toEqual(['GET /api/tags']);
    h.app.settings.setAi({ ollamaUrl: 'http://192.168.0.2:11434' });
    expect(h.app.store.getState().ai.ollamaUrl).toBe('http://127.0.0.1:11434');
    h.ai.mode = 'refused';
    await h.app.ai.refreshModels();
    expect(h.app.ai.getSnapshot().models).toMatchObject({
      state: 'offline',
      message: 'Ollama não encontrado em http://127.0.0.1:11434',
    });
  });
});

describe('AC-11.12 / AC-11.13 comandos sobre a seleção', () => {
  const DOC = 'Antes.\n\nUm parágrafo para resumir.\n\nDepois.\n';

  test('pedido = modelo + seleção; doc intacto até o clique; Substituir = before+result+after; 1 undo', async () => {
    const h = await setup({ 'nota.md': DOC });
    const view = await withEditor(h, 'nota.md');
    useOllama(h);
    const from = DOC.indexOf('Um');
    const to = DOC.indexOf('\n\nDepois');
    view.dispatch({ selection: { anchor: from, head: to } });
    expect(h.app.ai.commandEnabled()).toBe(true);
    const run = h.app.ai.runCommand('summarize');
    expect(view.state.doc.toString()).toBe(DOC);
    await run;
    const [call] = h.ai.calls();
    expect(call!.body).toMatchObject({
      messages: [
        { role: 'system', content: AI_PROMPTS.summarize },
        { role: 'user', content: DOC.slice(from, to) },
      ],
      stream: true,
    });
    const card = h.app.ai.getSnapshot().card!;
    expect(card.status).toBe('done');
    expect(card.title).toBe('IA: Resumir seleção · Ollama (qwen3.5:9b)');
    expect(view.state.doc.toString()).toBe(DOC);
    expect(h.app.ai.replaceSelection()).toBe(true);
    expect(view.state.doc.toString()).toBe(DOC.slice(0, from) + card.text + DOC.slice(to));
    undo(view);
    expect(view.state.doc.toString()).toBe(DOC);
  });

  test('Traduzir usa o idioma configurado; seleção editada → cartão velho; Descartar não muda o doc', async () => {
    const h = await setup({ 'nota.md': DOC });
    const view = await withEditor(h, 'nota.md');
    useOllama(h);
    h.app.settings.setAi({ language: 'de' });
    const from = DOC.indexOf('Um');
    view.dispatch({ selection: { anchor: from, head: from + 12 } });
    await h.app.ai.runCommand('translate');
    expect(JSON.stringify(h.ai.calls()[0]!.body)).toContain('para alemão,');
    view.dispatch({ changes: { from: from + 1, insert: 'X' } });
    expect(h.app.ai.getSnapshot().card!.stale).toBe(true);
    expect(h.app.ai.cardBlock('replace')).toBe(
      'A seleção mudou; descarte e rode o comando de novo.',
    );
    expect(h.app.ai.cardBlock('insert')).toBeNull();
    const before = view.state.doc.toString();
    h.app.ai.discardCard();
    expect(view.state.doc.toString()).toBe(before);
    expect(h.app.ai.getSnapshot().card).toBeNull();
  });

  test('sem seleção: desabilitado com motivo; 32.001 caracteres → aviso e 0 pedidos', async () => {
    const long = 'a'.repeat(32_001);
    const h = await setup({ 'nota.md': long });
    const view = await withEditor(h, 'nota.md');
    useOllama(h);
    expect(h.app.ai.commandEnabled()).toEqual({ reason: 'Selecione um texto no editor.' });
    view.dispatch({ selection: { anchor: 0, head: long.length } });
    await h.app.ai.runCommand('rewrite');
    expect(h.ai.calls()).toHaveLength(0);
    expect(h.app.store.getState().notices.map((n) => n.text)).toContain(
      'A seleção tem mais de 32.000 caracteres; selecione menos texto.',
    );
    h.app.settings.setAi({ provider: null });
    expect(h.app.ai.commandEnabled()).toEqual({ reason: 'Configure a IA em Configurações → IA.' });
  });
});

describe('AC-11.11 chat', () => {
  test('fluxo, Parar (0 atualizações depois), resposta, Inserir no cursor e Limpar', async () => {
    const h = await setup({ 'nota.md': 'abc' });
    const view = await withEditor(h, 'nota.md');
    useOllama(h);
    h.ai.chunkDelayMs = 30;
    const sent = h.app.ai.send('Olá?');
    await vi.advanceTimersByTimeAsync(200);
    const partial = h.app.ai.getSnapshot().messages.at(-1)!;
    expect(partial.status).toBe('streaming');
    h.app.ai.stop();
    const stopped = h.app.ai.getSnapshot().messages.at(-1)!;
    expect(stopped.status).toBe('stopped');
    await vi.advanceTimersByTimeAsync(2_000);
    await sent;
    expect(h.app.ai.getSnapshot().messages.at(-1)!.text).toBe(stopped.text);
    expect(h.ai.calls()[0]!.cancelled).toBe(true);
    // D-18: só o que o usuário digitou vai no pedido.
    expect(JSON.stringify(h.ai.calls()[0]!.body)).not.toContain('abc');

    h.ai.chunkDelayMs = 0;
    await h.app.ai.send('De novo');
    const answer = h.app.ai.getSnapshot().messages.at(-1)!;
    expect(answer.status).toBe('done');
    expect(h.app.ai.getSnapshot().chatAnnouncement).toBe(`Resposta da IA: ${answer.text}`);
    view.dispatch({ selection: { anchor: 1 } });
    h.app.ai.insertAnswer(answer.id);
    expect(view.state.doc.toString()).toBe(`a${answer.text}bc`);
    expect(h.app.ai.getSnapshot().chatStatus).toBe('Resposta inserida em “nota.md”.');
    h.app.ai.clear();
    expect(h.app.ai.getSnapshot().messages).toEqual([]);
  });

  test('erro do provedor aparece na conversa e o texto parcial fica', async () => {
    const h = await setup({ 'nota.md': '' });
    useOllama(h);
    h.ai.fixture = 'ollama/stream-truncated';
    await h.app.ai.send('Oi');
    const last = h.app.ai.getSnapshot().messages.at(-1)!;
    expect(last.status).toBe('error');
    expect(last.error).toBe('A resposta chegou incompleta.');
    expect(last.text.length).toBeGreaterThan(0);
  });
});
