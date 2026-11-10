// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { undo } from '@codemirror/commands';
import { StateEffect } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { AI_PROMPTS, AiTransportError, transportError, type AiTransportEvent } from '@simplemd/ai';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { capHistory, HISTORY_MAX_CHARS, type ChatMessage } from '../src/ai/controller';
import { PREFS_SAVE_DEBOUNCE_MS } from '../src/state/settings';
import { setup, type Harness } from './helpers';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  // O rAF do jsdom anda em tempo REAL; a publicação por quadro (NFR-33) dependeria de quanto o
  // `advanceTimersByTimeAsync` demora de verdade (TA-R2-1). Amarrado ao relógio falso, o quadro
  // (16 ms) é determinístico.
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
    setTimeout(() => callback(Date.now()), 16),
  );
  vi.stubGlobal('cancelAnimationFrame', (handle: number) => clearTimeout(handle));
});
afterEach(() => {
  vi.unstubAllGlobals();
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

  test('AC-B12.2: cancelar o diálogo nativo (CANCELLED) não mostra erro nem anúncio e não muda a chave', async () => {
    const h = await setup({ 'nota.md': '' });
    const before = h.app.ai.getSnapshot();
    h.ai.keychain.fail('CANCELLED');
    expect(await h.app.ai.saveKey('openai', CANARY)).toBe(false);
    let snapshot = h.app.ai.getSnapshot();
    expect(snapshot.keyErrors.openai).toBeUndefined();
    expect(snapshot.live).toBe(before.live);
    expect(snapshot.keys.openai).toBe(before.keys.openai);
    expect(h.ai.keychain.has('openai')).toBe(false);

    expect(await h.app.ai.saveKey('openai', CANARY)).toBe(true);
    const live = h.app.ai.getSnapshot().live;
    h.ai.keychain.fail('CANCELLED');
    await h.app.ai.removeKey('openai');
    snapshot = h.app.ai.getSnapshot();
    expect(snapshot.keys.openai).toBe('saved');
    expect(snapshot.keyErrors.openai).toBeUndefined();
    expect(snapshot.live).toBe(live);
    expect(h.ai.keychain.has('openai')).toBe(true);
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
    expect(answer.truncated).toBe(false);
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

describe('AC-R29-1 resposta cortada pelo limite do modelo', () => {
  const NOTICE = 'Resposta cortada pelo limite do modelo.';
  const MODELS = { openai: 'gpt-4o-mini', anthropic: 'claude-haiku-4-5', ollama: 'qwen3.5:9b' };
  const PROVIDERS = ['openai', 'anthropic', 'ollama'] as const;
  /** Como o anúncio fala a resposta antes do aviso: com um ponto no fim (vírgula vira ponto). */
  const ANNOUNCED = {
    openai: 'Olá! Um.',
    anthropic: 'Olá! Um, dois, três, quatro.',
    ollama: 'Olá! Aqui está de um.',
  };
  function expectedText(provider: string): string {
    const path = join(__dirname, `../../../packages/ai/test/fixtures/${provider}/chat-limit.json`);
    const fixture: { expected: { text: string } } = JSON.parse(readFileSync(path, 'utf8'));
    return fixture.expected.text;
  }

  async function useProvider(h: Harness, provider: (typeof PROVIDERS)[number]) {
    h.app.settings.setAi({ provider, models: { [provider]: MODELS[provider] } });
    if (provider === 'ollama') return;
    expect(await h.app.ai.saveKey(provider, 'chave-de-teste')).toBe(true);
    // r30: estes casos são do corte, não do diálogo de consentimento (coberto mais abaixo).
    h.app.settings.setAiConsent(provider, true);
  }

  /** Resposta do Ollama cortada pelo limite (`done_reason: length`), com o texto dado. */
  async function* ollamaLimit(text: string): AsyncGenerator<AiTransportEvent> {
    yield { kind: 'head', status: 200, contentType: 'application/x-ndjson' };
    const line = (content: string, done: boolean) =>
      `${JSON.stringify({ message: { role: 'assistant', content }, done, ...(done ? { done_reason: 'length' } : {}) })}\n`;
    if (text !== '') yield { kind: 'chunk', text: line(text, false) };
    yield { kind: 'chunk', text: line('', true) };
    yield { kind: 'end' };
  }

  test.each(PROVIDERS)('%s: chat com truncated "limit" e aviso no anúncio', async (provider) => {
    const h = await setup({ 'nota.md': '' });
    await useProvider(h, provider);
    h.ai.fixture = `${provider}/chat-limit`;
    await h.app.ai.send('Oi');
    const last = h.app.ai.getSnapshot().messages.at(-1)!;
    expect(last.status).toBe('done');
    expect(last.error).toBeNull();
    expect(last.text).toBe(expectedText(provider));
    expect(last.truncated).toBe('limit');
    expect(h.app.ai.getSnapshot().chatAnnouncement).toBe(
      `Resposta da IA: ${ANNOUNCED[provider]} ${NOTICE}`,
    );
  });

  test.each(PROVIDERS)(
    '%s: cartão com truncated "limit", aviso no anúncio e Substituir livre',
    async (provider) => {
      const DOC = 'Antes.\n\nUm parágrafo.\n';
      const h = await setup({ 'nota.md': DOC });
      const view = await withEditor(h, 'nota.md');
      await useProvider(h, provider);
      h.ai.fixture = `${provider}/chat-limit`;
      view.dispatch({ selection: { anchor: DOC.indexOf('Um'), head: DOC.length - 1 } });
      await h.app.ai.runCommand('rewrite');
      const card = h.app.ai.getSnapshot().card!;
      expect(card.status).toBe('done');
      expect(card.text).toBe(expectedText(provider));
      expect(card.truncated).toBe('limit');
      expect(h.app.ai.getSnapshot().cardAnnouncement).toBe(
        `Resultado da IA: ${ANNOUNCED[provider]} ${NOTICE}`,
      );
      expect(h.app.ai.cardBlock('replace')).toBeNull();
      expect(h.app.ai.cardBlock('insert')).toBeNull();
    },
  );

  test('resposta normal: truncated false e anúncio sem aviso (chat e cartão)', async () => {
    const DOC = 'Antes.\n\nUm parágrafo.\n';
    const h = await setup({ 'nota.md': DOC });
    const view = await withEditor(h, 'nota.md');
    await useProvider(h, 'anthropic');
    await h.app.ai.send('Oi');
    const last = h.app.ai.getSnapshot().messages.at(-1)!;
    expect(last.truncated).toBe(false);
    expect(h.app.ai.getSnapshot().chatAnnouncement).not.toContain(NOTICE);
    view.dispatch({ selection: { anchor: DOC.indexOf('Um'), head: DOC.length - 1 } });
    await h.app.ai.runCommand('rewrite');
    const card = h.app.ai.getSnapshot().card!;
    expect(card.status).toBe('done');
    expect(card.truncated).toBe(false);
    expect(h.app.ai.getSnapshot().cardAnnouncement).toBe(`Resultado da IA: ${card.text}`);
  });

  test('NB-1: resposta longa cortada → anúncio curto com o aviso (chat e cartão); vazia sem espaço duplo', async () => {
    const DOC = 'Antes.\n\nUm parágrafo.\n';
    const h = await setup({ 'nota.md': DOC });
    const view = await withEditor(h, 'nota.md');
    await useProvider(h, 'ollama');
    let answer = 'y'.repeat(2_500);
    vi.spyOn(h.platform.ai.transport, 'send').mockImplementation(() => ollamaLimit(answer));
    await h.app.ai.send('Oi');
    expect(h.app.ai.getSnapshot().messages.at(-1)!.truncated).toBe('limit');
    expect(h.app.ai.getSnapshot().chatAnnouncement).toBe(
      `Resposta da IA pronta (2.500 caracteres). ${NOTICE}`,
    );
    view.dispatch({ selection: { anchor: DOC.indexOf('Um'), head: DOC.length - 1 } });
    await h.app.ai.runCommand('rewrite');
    expect(h.app.ai.getSnapshot().cardAnnouncement).toBe(
      `Resultado da IA pronto (2.500 caracteres). ${NOTICE}`,
    );
    answer = '';
    await h.app.ai.send('De novo');
    expect(h.app.ai.getSnapshot().messages.at(-1)!.truncated).toBe('limit');
    expect(h.app.ai.getSnapshot().chatAnnouncement).toBe(`Resposta da IA. ${NOTICE}`);
  });
});

describe('r30 consentimento por provedor (AC-R30-1…3)', () => {
  const CLOUD = { ai: { provider: 'openai', models: { openai: 'gpt-4o-mini' } } };

  async function savedConfig(h: Harness) {
    await vi.advanceTimersByTimeAsync(PREFS_SAVE_DEBOUNCE_MS);
    await h.settle();
    return JSON.parse(h.port.readText(CONFIG) ?? '{}');
  }

  test('AC-R30-1: provedor de nuvem vindo do config.json → 0 pedidos até Enviar; Cancelar → 0 e a mensagem volta', async () => {
    const h = await setup({ 'nota.md': '', [CONFIG]: JSON.stringify(CLOUD) });
    expect(h.app.store.getState().ai.provider).toBe('openai');
    expect(await h.app.ai.saveKey('openai', 'chave-de-teste')).toBe(true);
    await h.app.ai.send('Olá');
    expect(h.ai.calls()).toEqual([]);
    const consent = h.app.ai.getSnapshot().consent!;
    expect(consent).toMatchObject({ provider: 'openai', kind: 'chat', text: 'Olá', previous: [] });
    expect(h.app.ai.getSnapshot().messages).toEqual([]);
    // Com o diálogo aberto, outro envio ou comando não faz nada.
    await h.app.ai.send('Outra');
    expect(h.app.ai.getSnapshot().consent).toBe(consent);
    h.app.ai.cancelConsent();
    await drain();
    expect(h.ai.calls()).toEqual([]);
    expect(h.app.ai.getSnapshot().consent).toBeNull();
    expect(h.app.ai.getSnapshot().chatRestore).toEqual({ id: consent.id, text: 'Olá' });
    expect(h.app.store.getState().ai.consent).toEqual({});
    expect((await savedConfig(h)).ai.consent).toBeUndefined();
  });

  test('AC-R30-1: comando sobre a seleção (Anthropic) → diálogo com a seleção; Cancelar → 0 pedidos e sem cartão', async () => {
    const DOC = 'Antes.\n\nUm parágrafo.\n';
    const h = await setup({ 'nota.md': DOC });
    const view = await withEditor(h, 'nota.md');
    h.app.settings.setAi({ provider: 'anthropic', models: { anthropic: 'claude-haiku-4-5' } });
    expect(await h.app.ai.saveKey('anthropic', 'chave-de-teste')).toBe(true);
    view.dispatch({ selection: { anchor: DOC.indexOf('Um'), head: DOC.length - 1 } });
    await h.app.ai.runCommand('summarize');
    expect(h.ai.calls()).toEqual([]);
    expect(h.app.ai.getSnapshot().card).toBeNull();
    const pending = h.app.ai.getSnapshot().consent;
    // Com o diálogo aberto, outro comando ou envio não faz nada.
    await h.app.ai.runCommand('rewrite');
    await h.app.ai.send('Oi');
    expect(h.app.ai.getSnapshot().consent).toBe(pending);
    expect(h.app.ai.getSnapshot().consent).toMatchObject({
      provider: 'anthropic',
      kind: 'command',
      action: 'IA: Resumir seleção',
      text: 'Um parágrafo.',
      previous: [],
    });
    h.app.ai.cancelConsent();
    await drain();
    expect(h.ai.calls()).toEqual([]);
    expect(h.app.ai.getSnapshot().card).toBeNull();
    expect(h.app.ai.getSnapshot().chatRestore).toBeNull();
    // Enviar: o comando roda; a autorização da pasta vale também para o chat.
    await h.app.ai.runCommand('summarize');
    await h.app.ai.confirmConsent();
    expect(h.ai.calls().map((c) => `${c.method} ${c.path}`)).toEqual(['POST /v1/messages']);
    expect(h.app.ai.getSnapshot().card!.status).toBe('done');
    await h.app.ai.send('Oi');
    expect(h.app.ai.getSnapshot().consent).toBeNull();
    expect(h.ai.calls()).toHaveLength(2);
  });

  test('R30-N2: a seleção muda com o diálogo aberto → Enviar não manda nada, não grava e avisa', async () => {
    const DOC = 'Antes.\n\nUm parágrafo.\n\nOutro trecho.\n';
    const h = await setup({ 'nota.md': DOC });
    const view = await withEditor(h, 'nota.md');
    h.app.settings.setAi({ provider: 'anthropic', models: { anthropic: 'claude-haiku-4-5' } });
    expect(await h.app.ai.saveKey('anthropic', 'chave-de-teste')).toBe(true);
    const shown = { anchor: DOC.indexOf('Um'), head: DOC.indexOf('\n\nOutro') };
    view.dispatch({ selection: shown });
    await h.app.ai.runCommand('summarize');
    expect(h.app.ai.getSnapshot().consent).toMatchObject({ text: 'Um parágrafo.' });
    // Com o diálogo aberto, a seleção passa a ser outro trecho (ex.: recarga do disco).
    view.dispatch({ selection: { anchor: DOC.indexOf('Outro'), head: DOC.length - 1 } });
    await h.app.ai.confirmConsent();
    await drain();
    expect(h.ai.calls()).toEqual([]);
    expect(h.app.ai.getSnapshot().consent).toBeNull();
    expect(h.app.ai.getSnapshot().card).toBeNull();
    expect(h.app.store.getState().ai.consent).toEqual({});
    expect(h.app.store.getState().notices.filter((n) => n.notice === 'ai-error')).toMatchObject([
      { kind: 'error', text: 'A seleção mudou com o diálogo aberto; nada foi enviado.' },
    ]);
    // Mesma seleção do diálogo: Enviar segue e manda exatamente o texto mostrado.
    view.dispatch({ selection: shown });
    await h.app.ai.runCommand('summarize');
    await h.app.ai.confirmConsent();
    expect(h.ai.calls()).toHaveLength(1);
    expect(JSON.stringify(h.ai.calls()[0]!.body)).toContain('Um parágrafo.');
    expect(JSON.stringify(h.ai.calls()[0]!.body)).not.toContain('Outro trecho.');
  });

  test('NB-3 (M1): troca de aba com a mesma seleção na outra nota → Enviar não manda nada', async () => {
    const DOC = 'Antes.\n\nUm parágrafo.\n';
    const h = await setup({ 'a.md': DOC, 'b.md': DOC });
    const viewA = await withEditor(h, 'a.md');
    h.app.settings.setAi({ provider: 'anthropic', models: { anthropic: 'claude-haiku-4-5' } });
    expect(await h.app.ai.saveKey('anthropic', 'chave-de-teste')).toBe(true);
    const shown = { anchor: DOC.indexOf('Um'), head: DOC.length - 1 };
    viewA.dispatch({ selection: shown });
    await h.app.ai.runCommand('summarize');
    expect(h.app.ai.getSnapshot().consent).toMatchObject({ text: 'Um parágrafo.' });
    // Com o diálogo aberto, a aba ativa passa a ser `b.md`, com o mesmo texto selecionado.
    const viewB = await withEditor(h, 'b.md');
    viewB.dispatch({ selection: shown });
    expect(h.app.store.getState().activeId).toBe('b.md');
    await h.app.ai.confirmConsent();
    await drain();
    expect(h.ai.calls()).toEqual([]);
    expect(h.app.ai.getSnapshot().card).toBeNull();
    expect(h.app.store.getState().ai.consent).toEqual({});
    expect(h.app.store.getState().notices.filter((n) => n.notice === 'ai-error')).toMatchObject([
      { text: 'A seleção mudou com o diálogo aberto; nada foi enviado.' },
    ]);
  });

  test('R30-N1: conversa começada no Ollama e trocada para a nuvem → o diálogo mostra cada mensagem anterior', async () => {
    const h = await setup({ 'nota.md': '' });
    useOllama(h);
    await h.app.ai.send('Resuma: segredo local.');
    expect(h.ai.calls().map((c) => c.provider)).toEqual(['ollama']);
    const answer = h.app.ai.getSnapshot().messages.at(-1)!;
    h.app.settings.setAi({ provider: 'openai', models: { openai: 'gpt-4o-mini' } });
    expect(await h.app.ai.saveKey('openai', 'chave-de-teste')).toBe(true);
    await h.app.ai.send('E agora?');
    expect(h.ai.calls()).toHaveLength(1);
    expect(h.app.ai.getSnapshot().consent!.previous).toEqual([
      { role: 'user', heading: 'Você', text: 'Resuma: segredo local.' },
      { role: 'assistant', heading: 'IA (Ollama · qwen3.5:9b)', text: answer.text },
    ]);
    expect(answer.text).not.toBe('');
    // O que o "Enviar" manda é o que o diálogo mostrou.
    await h.app.ai.confirmConsent();
    const body = h.ai.calls().at(-1)!.body as { messages: Array<{ content: string }> };
    expect(body.messages.map((m) => m.content)).toEqual([
      'Resuma: segredo local.',
      answer.text,
      'E agora?',
    ]);
  });

  test('R30-CR-NB2: config.json trocado por fora no meio da sessão (Ollama → OpenAI), recarga → diálogo e 0 pedidos à nuvem', async () => {
    const LOCAL = { ai: { provider: 'ollama', models: { ollama: 'qwen3.5:9b' } } };
    const h = await setup({ 'nota.md': '', [CONFIG]: JSON.stringify(LOCAL) });
    expect(await h.app.ai.saveKey('openai', 'chave-de-teste')).toBe(true);
    await h.app.ai.send('Oi');
    expect(h.ai.calls().map((c) => c.provider)).toEqual(['ollama']);
    h.port.externalWrite(CONFIG, JSON.stringify(CLOUD));
    await h.app.sync.openVault('shell');
    expect(h.app.store.getState().ai).toMatchObject({ provider: 'openai', consent: {} });
    await h.app.ai.send('Olá');
    await drain();
    expect(h.app.ai.getSnapshot().consent).toMatchObject({ provider: 'openai', text: 'Olá' });
    expect(h.ai.calls().map((c) => c.provider)).toEqual(['ollama']);
  });

  test('AC-R30-1: provedor trocado com o diálogo aberto → Enviar vale como Cancelar (nada gravado nem enviado)', async () => {
    const h = await setup({ 'nota.md': '', [CONFIG]: JSON.stringify(CLOUD) });
    expect(await h.app.ai.saveKey('openai', 'chave-de-teste')).toBe(true);
    expect(await h.app.ai.saveKey('anthropic', 'chave-de-teste')).toBe(true);
    await h.app.ai.send('Olá');
    const { id } = h.app.ai.getSnapshot().consent!;
    h.app.settings.setAi({ provider: 'anthropic', models: { anthropic: 'claude-haiku-4-5' } });
    await h.app.ai.confirmConsent();
    await drain();
    expect(h.ai.calls()).toEqual([]);
    expect(h.app.ai.getSnapshot().consent).toBeNull();
    expect(h.app.ai.getSnapshot().chatRestore).toEqual({ id, text: 'Olá' });
    expect(h.app.store.getState().ai.consent).toEqual({});
    expect((await savedConfig(h)).ai.consent).toBeUndefined();
  });

  test('pasta fechada com o diálogo aberto → o pedido some e Enviar não faz nada', async () => {
    const h = await setup({ 'nota.md': '', [CONFIG]: JSON.stringify(CLOUD) });
    expect(await h.app.ai.saveKey('openai', 'chave-de-teste')).toBe(true);
    await h.app.ai.send('Olá');
    expect(h.app.ai.getSnapshot().consent).not.toBeNull();
    h.app.ai.reset();
    expect(h.app.ai.getSnapshot().consent).toBeNull();
    expect(h.app.ai.getSnapshot().chatRestore).toBeNull();
    await h.app.ai.confirmConsent();
    await drain();
    expect(h.ai.calls()).toEqual([]);
    expect(h.app.store.getState().ai.consent).toEqual({});
  });

  test('AC-R30-2: Enviar grava ai.consent (nunca a chave); não pergunta de novo; Revogar → pergunta', async () => {
    const h = await setup({ 'nota.md': '', [CONFIG]: JSON.stringify(CLOUD) });
    expect(await h.app.ai.saveKey('openai', CANARY)).toBe(true);
    await h.app.ai.send('Olá');
    await h.app.ai.confirmConsent();
    expect(h.ai.calls().map((c) => `${c.method} ${c.path}`)).toEqual(['POST /v1/chat/completions']);
    expect(h.app.ai.getSnapshot().messages.at(-1)!.status).toBe('done');
    const saved = await savedConfig(h);
    expect(saved.ai).toEqual({
      provider: 'openai',
      models: { openai: 'gpt-4o-mini' },
      ollamaUrl: 'http://127.0.0.1:11434',
      language: 'en',
      consent: { openai: true },
    });
    expect(JSON.stringify(saved.ai)).not.toMatch(/key|chave/i);
    for (const [, latin1] of h.port.snapshot().files) expect(latin1).not.toContain('CANARY');

    await h.app.ai.send('De novo');
    expect(h.app.ai.getSnapshot().consent).toBeNull();
    expect(h.ai.calls()).toHaveLength(2);

    h.app.ai.revokeConsent('openai');
    expect(h.app.ai.getSnapshot().live).toBe('Autorização para OpenAI revogada.');
    expect('consent' in (await savedConfig(h)).ai).toBe(false);
    await h.app.ai.send('Mais uma');
    expect(h.app.ai.getSnapshot().consent).toMatchObject({ provider: 'openai' });
    expect(h.app.ai.getSnapshot().consent!.previous).toHaveLength(4);
    expect(h.ai.calls()).toHaveLength(2);
  });

  test('consent no config.json: true vale na abertura; valor inválido → aviso e pergunta', async () => {
    const granted = { ai: { ...CLOUD.ai, consent: { openai: true } } };
    const h = await setup({ 'nota.md': '', [CONFIG]: JSON.stringify(granted) });
    expect(await h.app.ai.saveKey('openai', 'chave-de-teste')).toBe(true);
    await h.app.ai.send('Olá');
    expect(h.app.ai.getSnapshot().consent).toBeNull();
    expect(h.ai.calls()).toHaveLength(1);

    const invalid = { ai: { ...CLOUD.ai, consent: { openai: 'sim', ollama: true } } };
    const bad = await setup({ 'nota.md': '', [CONFIG]: JSON.stringify(invalid) });
    expect(bad.app.store.getState().ai.consent).toEqual({});
    const notices = bad.app.store.getState().notices.filter((n) => n.notice === 'config-field');
    expect(notices.map((n) => n.detail)).toEqual(['ai.consent.openai']);
    expect(await bad.app.ai.saveKey('openai', 'chave-de-teste')).toBe(true);
    await bad.app.ai.send('Olá');
    expect(bad.app.ai.getSnapshot().consent).toMatchObject({ provider: 'openai' });
    expect(bad.ai.calls()).toEqual([]);
  });

  test('AC-R30-3: Ollama nunca pergunta', async () => {
    const h = await setup({ 'nota.md': '' });
    useOllama(h);
    await h.app.ai.send('Oi');
    expect(h.app.ai.getSnapshot().consent).toBeNull();
    expect(h.ai.calls().map((c) => `${c.method} ${c.path}`)).toEqual(['POST /api/chat']);
  });
});

describe('r30 teto do histórico do chat (AC-R30-4)', () => {
  const m = (role: 'user' | 'assistant', size: number) => ({ role, content: 'x'.repeat(size) });

  test('capHistory: abaixo do teto não muda; acima, sai das mais antigas e começa por user', () => {
    const small = [m('user', 10), m('assistant', 10), m('user', 10)];
    expect(capHistory(small, HISTORY_MAX_CHARS)).toEqual({ messages: small, dropped: 0 });
    const big = [
      m('user', 10_000),
      m('user', 50_000),
      m('assistant', 30_000),
      m('user', 30_000),
      m('assistant', 20_000),
      m('user', 10_000),
    ];
    // Do fim: 10 + 20 + 30 + 30 = 90 mil cabem; + 50 mil não. A 1ª que fica seria `assistant`.
    expect(capHistory(big, HISTORY_MAX_CHARS)).toEqual({ messages: big.slice(3), dropped: 3 });
    // A mensagem nova sempre vai, mesmo sozinha acima do teto.
    expect(capHistory([m('assistant', 5), m('user', 200)], 100)).toEqual({
      messages: [m('user', 200)],
      dropped: 1,
    });
  });

  test('chat: 4 mensagens de 30.000 → a 4ª vai sem as 2 mais antigas, com aviso; total ≤ 96.000', async () => {
    const h = await setup({ 'nota.md': '' });
    useOllama(h);
    for (const c of ['a', 'b', 'c', 'd']) await h.app.ai.send(c.repeat(30_000));
    const users = h.app.ai.getSnapshot().messages.filter((msg) => msg.role === 'user');
    expect(users.map((u) => u.historyDropped)).toEqual([0, 0, 0, 2]);
    // R30-CR-NITS: só a mensagem do usuário corta o histórico; o tipo recusa uma resposta com
    // historyDropped > 0 (o `tsc` falha se a linha abaixo passar a compilar).
    const answer = h.app.ai.getSnapshot().messages.find((msg) => msg.role === 'assistant')!;
    // @ts-expect-error resposta não carrega mensagens fora do envio
    const wrong: ChatMessage = { ...answer, role: 'assistant', historyDropped: 2 };
    expect(wrong.role).toBe('assistant');
    const body = h.ai.calls().at(-1)!.body as {
      messages: Array<{ role: string; content: string }>;
    };
    const total = body.messages.reduce((sum, msg) => sum + msg.content.length, 0);
    expect(total).toBeLessThanOrEqual(HISTORY_MAX_CHARS);
    expect(body.messages[0]!).toMatchObject({ role: 'user', content: 'b'.repeat(30_000) });
    expect(body.messages.at(-1)!).toEqual({ role: 'user', content: 'd'.repeat(30_000) });
  });
});

/**
 * r31 (AC-R31-1): o portão de sessão do Rust, espelhado no harness (`h.ai.session`). A pasta já
 * autorizou o provedor (r30) para isolar o portão nativo; a resposta do "diálogo" vem de `answer`.
 */
describe('r31 confirmação nativa por sessão (AC-R31-1)', () => {
  const REFUSED = 'Envio à IA não autorizado nesta sessão.';
  const GRANTED = {
    ai: {
      provider: 'openai',
      models: { openai: 'gpt-4o-mini', anthropic: 'claude-haiku-4-5' },
      consent: { openai: true, anthropic: true },
    },
  };

  test('chat: recusar → 0 pedidos e erro tipado; aceitar → segue sem perguntar de novo', async () => {
    const h = await setup({ 'nota.md': '', [CONFIG]: JSON.stringify(GRANTED) });
    expect(await h.app.ai.saveKey('openai', 'chave-de-teste')).toBe(true);
    h.ai.session.answer = 'refuse';
    await h.app.ai.send('Olá');
    expect(h.app.ai.getSnapshot().consent).toBeNull();
    expect(h.ai.calls()).toEqual([]);
    expect(h.ai.session.asked()).toBe(1);
    expect(h.ai.usage()).toEqual({ cloud: 0, local: 0 });
    const refused = h.app.ai.getSnapshot().messages.at(-1)!;
    expect(refused).toMatchObject({ status: 'error', error: REFUSED });
    // R31-EV-N1: a recusa também aparece na linha `role=status` do chat (`ai-chat-status`).
    expect(h.app.ai.getSnapshot().chatStatus).toBe(REFUSED);

    h.ai.session.answer = 'accept';
    await h.app.ai.send('De novo');
    await h.app.ai.send('Mais uma');
    expect(h.ai.calls().map((c) => `${c.method} ${c.path}`)).toEqual([
      'POST /v1/chat/completions',
      'POST /v1/chat/completions',
    ]);
    expect(h.ai.session.asked()).toBe(2);
    expect(h.ai.usage()).toEqual({ cloud: 2, local: 0 });
    expect(h.app.ai.getSnapshot().messages.at(-1)!.status).toBe('done');
  });

  test('comando sobre a seleção recusado → 0 pedidos e o cartão mostra o erro; outro provedor pergunta de novo', async () => {
    const DOC = 'Um parágrafo.\n';
    const h = await setup({ 'nota.md': DOC, [CONFIG]: JSON.stringify(GRANTED) });
    const view = await withEditor(h, 'nota.md');
    expect(await h.app.ai.saveKey('openai', 'chave-de-teste')).toBe(true);
    expect(await h.app.ai.saveKey('anthropic', 'chave-de-teste')).toBe(true);
    await h.app.ai.send('Olá');
    expect(h.ai.session.asked()).toBe(1);

    h.app.settings.setAi({ provider: 'anthropic' });
    h.ai.session.answer = 'refuse';
    view.dispatch({ selection: { anchor: 0, head: DOC.length - 1 } });
    await h.app.ai.runCommand('summarize');
    await drain();
    expect(h.ai.session.asked()).toBe(2);
    expect(h.ai.calls().map((c) => c.provider)).toEqual(['openai']);
    expect(h.app.ai.getSnapshot().card).toMatchObject({ status: 'error', error: REFUSED });
    expect(view.state.doc.toString()).toBe(DOC);
    expect(h.ai.usage()).toEqual({ cloud: 1, local: 0 });
  });

  test('erro nativo SEND_NOT_CONFIRMED passa pelo mapa de códigos: tipado, com a mensagem fixa do Rust', () => {
    const native = { code: 'SEND_NOT_CONFIRMED', message: REFUSED };
    expect(AiTransportError.from(native).code).toBe('SEND_NOT_CONFIRMED');
    expect(transportError('anthropic', native, 'http://127.0.0.1:11434')).toMatchObject({
      code: 'TRANSPORT',
      provider: 'anthropic',
      message: REFUSED,
      transportCode: 'SEND_NOT_CONFIRMED',
    });
    // Um código fora do mapa vira UNKNOWN: o de cima só fica tipado por estar no mapa.
    expect(AiTransportError.from({ code: 'NAO_EXISTE', message: 'x' }).code).toBe('UNKNOWN');
  });

  test('Ollama não pergunta e conta como pedido local', async () => {
    const h = await setup({ 'nota.md': '' });
    useOllama(h);
    h.ai.session.answer = 'refuse';
    await h.app.ai.send('Oi');
    expect(h.ai.session.asked()).toBe(0);
    expect(h.ai.calls().map((c) => `${c.method} ${c.path}`)).toEqual(['POST /api/chat']);
    expect(h.ai.usage()).toEqual({ cloud: 0, local: 1 });
  });
});
