// @vitest-environment jsdom
// CR2-01 (R-AI1 da revisão r2): a aba do cartão da IA recarregada por inteiro (mudança externa numa
// aba limpa, "Recarregar" do conflito) troca o EditorState com `setState`, sem mudanças para mapear a
// faixa. "Substituir seleção" e "Inserir abaixo" nunca podem aplicar a faixa antiga no texto novo.
import { StateEffect } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setup, type Harness } from './helpers';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
});
afterEach(() => {
  vi.useRealTimers();
});
Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => new DOMRect();

const DOC = 'Antes.\n\nUm parágrafo para resumir.\n\nDepois.\n';
const EXTERNAL = 'Linha nova escrita fora do app, que o usuário nunca selecionou.\n';
const STALE = 'A seleção mudou; descarte e rode o comando de novo.';

/** Estado da aba como o App mostra: refresh do host + o ouvinte que alimenta o cartão. */
const shown = (h: Harness, path: string) =>
  h.app.plugins.editor.refresh(h.app.registry.get(path)!.state).update({
    effects: StateEffect.appendConfig.of(
      EditorView.updateListener.of((update) => h.app.ai.onEditorChange(path, update)),
    ),
  }).state;

async function cardOnSelection() {
  const h = await setup({ 'nota.md': DOC }, { watch: false });
  await h.app.sync.openFile('nota.md');
  const view = new EditorView({
    state: shown(h, 'nota.md'),
    parent: document.createElement('div'),
  });
  h.app.plugins.editor.attach(view);
  h.app.settings.setAi({ provider: 'ollama', models: { ollama: 'qwen3.5:9b' } });
  view.dispatch({ selection: { anchor: DOC.indexOf('Um'), head: DOC.indexOf('\n\nDepois') } });
  await h.app.ai.runCommand('summarize');
  expect(h.app.ai.getSnapshot().card!.status).toBe('done');
  expect(h.app.ai.cardBlock('replace')).toBeNull();
  return { h, view };
}

test('R-AI1: recarga externa da aba do cartão → cartão velho; Substituir e Inserir não aplicam', async () => {
  const { h, view } = await cardOnSelection();
  h.port.externalWrite('nota.md', EXTERNAL);
  await h.app.sync.checkTab('nota.md');
  expect(h.text('nota.md')).toBe(EXTERNAL);
  // O que App.showTab faz em registry.onReplace: setState com o estado novo da aba.
  view.setState(shown(h, 'nota.md'));

  expect(h.app.ai.getSnapshot().card!.stale).toBe(true);
  expect(h.app.ai.cardBlock('replace')).toBe(STALE);
  expect(h.app.ai.cardBlock('insert')).toBe(STALE);
  expect(h.app.ai.cardBlock('copy')).toBeNull();
  expect(h.app.ai.replaceSelection()).toBe(false);
  expect(h.app.ai.insertBelow()).toBe(false);
  expect(view.state.doc.toString()).toBe(EXTERNAL);
  // Nem o autosave grava nada: o documento continua igual ao disco.
  await vi.advanceTimersByTimeAsync(5000);
  expect(h.port.readText('nota.md')).toBe(EXTERNAL);
});

test('R-AI1b: estado trocado sem aviso do registro → a revalidação na hora de aplicar recusa', async () => {
  const { h, view } = await cardOnSelection();
  // Outro documento no editor sem passar por registry.replace (nenhuma mudança mapeável).
  const other = view.state.update({
    changes: { from: 0, to: view.state.doc.length, insert: EXTERNAL },
  });
  view.setState(other.state);
  expect(h.app.ai.replaceSelection()).toBe(false);
  expect(h.app.ai.getSnapshot().card!.stale).toBe(true);
  expect(h.app.ai.insertBelow()).toBe(false);
  expect(view.state.doc.toString()).toBe(EXTERNAL);
});

test('edição normal continua mapeando a faixa: Inserir abaixo vale, Substituir só sem mudar a faixa', async () => {
  const { h, view } = await cardOnSelection();
  view.dispatch({ changes: { from: 0, insert: 'Novo início. ' } });
  expect(h.app.ai.getSnapshot().card!.stale).toBe(false);
  expect(h.app.ai.cardBlock('replace')).toBeNull();
  expect(h.app.ai.replaceSelection()).toBe(true);
  const doc = view.state.doc.toString();
  expect(doc.startsWith('Novo início. Antes.\n\n')).toBe(true);
  expect(doc).not.toContain('Um parágrafo para resumir.');
  expect(doc.endsWith('\n\nDepois.\n')).toBe(true);
});
