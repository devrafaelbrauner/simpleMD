// @vitest-environment jsdom
import '../../../packages/core/test/setup-dom';
import { EditorView } from '@codemirror/view';
import { problemsCommandsFacet } from '@simplemd/core';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { internalPluginDescriptors } from '../src/plugins/internal/index';
import lint from '../src/plugins/internal/lint';
import { setup, type Harness } from './helpers';

/**
 * r7 S5 (I-5) no app: descritor (desligado por padrão, ordem 60, "Regras em uso"), privilégios do
 * contexto (`files` só `.markdownlint.json(c)`, `problems`) e o caminho inteiro — ligar o lint
 * numa nota com espaço no fim da linha mostra MD009 (a mesma checagem do AC-I5.6, no jsdom; o
 * app real/WKWebView fica para a Fase 4, MAC).
 */
const views: EditorView[] = [];
afterEach(() => {
  while (views.length) views.pop()?.destroy();
  document.body.innerHTML = '';
});

function open(files: Record<string, string>) {
  return setup(files, { open: false, internalDescriptors: internalPluginDescriptors() });
}

function mountEditor(h: Harness, doc: string, path: string): EditorView {
  const parent = document.body.appendChild(document.createElement('div'));
  const view = new EditorView({ state: h.app.plugins.editor.createState(doc, path), parent });
  h.app.plugins.editor.attach(view);
  views.push(view);
  return view;
}

/**
 * Problemas publicados, lidos como o usuário lê: o painel "Problemas" aberto pelo comando da facet
 * (o app não importa `@codemirror/lint`). `[]` = facet ausente ou painel "Nenhum problema".
 */
function rules(view: EditorView): string[] {
  const problems = view.state.facet(problemsCommandsFacet);
  if (!problems) return [];
  problems.openPanel(view);
  const options = [...view.dom.querySelectorAll('.cm-panel-lint [role=option]')];
  const out = options
    .map((option) => option.textContent ?? '')
    .filter((text) => text !== 'Nenhum problema')
    .map((text) => text.split(' ')[0] ?? '');
  view.contentDOM.focus();
  return out;
}

describe('descritor simplemd.lint', () => {
  test('desligado por padrão, ordem 60, nome/descrição STR-179 e a opção "Regras em uso"', async () => {
    expect(lint).toMatchObject({
      id: 'simplemd.lint',
      name: 'Lint de Markdown',
      description:
        'Aponta problemas de estilo do Markdown (markdownlint). Só mostra; nunca corrige.',
      defaultEnabled: false,
      order: 60,
    });
    const [rulesOption] = lint.options ?? [];
    expect(rulesOption).toMatchObject({ key: 'rules', kind: 'info', label: 'Regras em uso' });
    const info = (files: Record<string, string>) =>
      rulesOption!.info!({
        values: {},
        readFile: async (name) => (name in files ? { text: files[name]! } : { error: 'missing' }),
      });
    expect(await info({})).toBe('Padrão do simpleMD (MD013, MD033 e MD041 desligadas)');
    expect(await info({ '.markdownlint.json': '{"MD013": true}' })).toBe(
      'Arquivo .markdownlint.json desta pasta',
    );
    expect(await info({ '.markdownlint.jsonc': '{ // x\n}' })).toBe(
      'Arquivo .markdownlint.jsonc desta pasta',
    );
    expect(await info({ '.markdownlint.json': '{' })).toBe(
      'Arquivo .markdownlint.json desta pasta inválido; usando o padrão do simpleMD',
    );
  });
});

describe('lint ligado no app (AC-I5.6 no jsdom; AC-I5.2 pela porta de arquivos)', () => {
  test('ligar o lint numa nota com espaço no fim da linha mostra MD009; desligar tira tudo', async () => {
    const h = await open({ 'nota.md': '# Nota\n\nTexto com espaço no fim \n' });
    await h.app.sync.openVault('welcome');
    const view = mountEditor(h, '# Nota\n\nTexto com espaço no fim \n', 'nota.md');
    expect(rules(view)).toEqual([]);
    expect(view.state.facet(problemsCommandsFacet)).toBeNull();
    await h.app.plugins.host.setEnabled('simplemd.lint', true);
    await vi.waitFor(() => expect(rules(view)).toEqual(['MD009']));
    expect(view.state.facet(problemsCommandsFacet)).not.toBeNull();
    expect(view.dom.querySelectorAll('.cm-gutter-problems').length).toBe(1);
    await h.app.plugins.host.setEnabled('simplemd.lint', false);
    await vi.waitFor(() => expect(view.dom.querySelector('.cm-gutter-problems')).toBeNull());
    expect(view.state.facet(problemsCommandsFacet)).toBeNull();
  });

  test('.markdownlint.json "MD013": true vale; `.markdownlint.cjs` presente: 0 leituras dele', async () => {
    const long = '# Nota\n\n' + 'palavra '.repeat(15) + '\n';
    const h = await open({
      'nota.md': long,
      '.markdownlint.json': '{ "MD013": true }',
      '.markdownlint.cjs': 'module.exports = { MD013: false };',
    });
    await h.app.sync.openVault('welcome');
    const view = mountEditor(h, long, 'nota.md');
    await h.app.plugins.host.setEnabled('simplemd.lint', true);
    await vi.waitFor(() => expect(rules(view)).toContain('MD013'));
    const calls = h.port.calls();
    const reads = calls.filter((call) => call.op === 'readFile').map((call) => call.abs);
    expect(reads.some((path) => path.endsWith('/.markdownlint.json'))).toBe(true);
    // Nenhuma operação (leitura, lstat, …) toca o `.cjs`: não existe caminho de código para ele.
    expect(calls.filter((call) => call.abs.includes('.markdownlint.cjs'))).toEqual([]);
  });
});
