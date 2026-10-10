import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { closeLintPanel, setDiagnostics } from '@codemirror/lint';
import type { EditorView } from '@codemirror/view';
import { escapeArbiter, runInteract } from '@simplemd/core';
import { afterEach, describe, expect, it } from 'vitest';
import {
  diagnosticsExtension,
  diagnosticsUi,
  problemDiagnostic,
  problemsCommands,
  type ProblemInfo,
} from '../src/shared/diagnostics-ui';
import { toDiagnostics } from '../src/lint/source';
import { lintMarkdown } from '../src/lint/worker';
import { DEFAULT_LINT_CONFIG } from '../src/lint/rules';
import { destroyViews, mountView } from './helpers';
import { fakeLintHost, lastAnnouncement } from './lint-helpers';

/**
 * AC-I5.5 (parte VT) e a estrutura do `@codemirror/lint` 6.9.7 de que a UI depende (D-R7-F29):
 * calha própria, cartão W2 (teclado), painel W5 com frases pt-BR e F8/Shift-F8 com anúncio.
 * Glossário (EN): cartão = card; painel = panel; calha = gutter; anúncio = announcement.
 */
const DOC = '# Lint\n\nEspaço no fim   \n\nOutra linha   \n';

function lintView(doc = DOC, extra: unknown[] = []): { view: EditorView; opened: string[] } {
  const fake = fakeLintHost();
  const view = mountView(doc, [escapeArbiter, diagnosticsExtension(fake.host), ...(extra as [])], {
    anchor: 0,
  });
  const diagnostics = toDiagnostics(view.state, lintMarkdown(doc, DEFAULT_LINT_CONFIG), (url) =>
    fake.host.links.openExternal(url),
  );
  view.dispatch(setDiagnostics(view.state, diagnostics));
  return { view, opened: fake.opened };
}

const card = (view: EditorView) =>
  view.dom.querySelector<HTMLElement>('[data-testid="problem-card"]');

function key(target: Element, init: KeyboardEventInit) {
  target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
}

afterEach(() => destroyViews());

describe('calha e sublinhados (DESIGN §R7.6.11)', () => {
  it('um glifo `info` por linha com problema, `aria-hidden`, e sublinhado por `markClass`', () => {
    const { view } = lintView();
    const glyphs = view.dom.querySelectorAll('.cm-gutter-problems .cm-problem-glyph-lint');
    expect(glyphs.length).toBe(2);
    for (const glyph of glyphs) expect(glyph.getAttribute('aria-hidden')).toBe('true');
    const marks = view.contentDOM.querySelectorAll('.cm-lintRange-lint');
    expect(marks.length).toBe(2);
  });

  it('o mais forte da linha vence na calha (ortografia > gramática > lint)', () => {
    const { view } = lintView('palavra errada aqui\n');
    const info = (kind: ProblemInfo['kind']): ProblemInfo => ({
      source: kind === 'lint' ? 'lint' : 'languagetool',
      kind,
      title: 'T',
      label: 'T',
      body: 'b',
      actions: [],
    });
    view.dispatch(
      setDiagnostics(view.state, [
        problemDiagnostic(0, 7, info('lint')),
        problemDiagnostic(8, 14, info('spelling')),
        problemDiagnostic(15, 19, info('grammar')),
      ]),
    );
    const glyphs = [...view.dom.querySelectorAll('.cm-gutter-problems .cm-problem-glyph')];
    expect(glyphs.map((g) => g.getAttribute('class'))).toEqual([
      'cm-problem-glyph cm-problem-glyph-spelling',
    ]);
  });

  it('lint + LT ligados: a MESMA constante entra uma vez (uma calha só)', () => {
    const fake = fakeLintHost();
    const view = mountView('x', [diagnosticsExtension(fake.host), diagnosticsExtension(fake.host), diagnosticsUi]);
    expect(view.dom.querySelectorAll('.cm-gutter-problems').length).toBe(1);
  });

  it('tema sem `url(`/`data:` e a dica padrão do pacote filtrada (D-R7-F14b, CSP)', () => {
    // Só o código (sem comentários): nenhuma imagem `url(`/`data:` no tema.
    const source = readFileSync(join(__dirname, '../src/shared/diagnostics-ui.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    expect(source).not.toMatch(/url\(|data:image/);
    expect(source).toContain('tooltipFilter: () => []');
  });
});

describe('AC-I5.5 cartão W2 pelo teclado (Mod-Shift-Enter = runInteract)', () => {
  it('título "Problema: MD009 · no-trailing-spaces", descrição pt-BR e só "Saiba mais"', () => {
    const { view, opened } = lintView();
    const pos = view.state.doc.line(3).to - 1;
    view.dispatch({ selection: { anchor: pos } });
    expect(runInteract(view)).toBe(true);
    const dialog = card(view);
    expect(dialog).not.toBeNull();
    expect(dialog?.dataset.source).toBe('lint');
    expect(dialog?.getAttribute('role')).toBe('dialog');
    expect(dialog?.getAttribute('aria-modal')).toBe('false');
    const title = document.getElementById(dialog?.getAttribute('aria-labelledby') ?? '');
    expect(title?.textContent).toBe('Problema: MD009 · no-trailing-spaces');
    expect(dialog?.querySelector('.cm-problem-body')?.textContent).toBe('Espaços no fim da linha.');
    const buttons = [...(dialog?.querySelectorAll('button') ?? [])];
    expect(buttons.map((b) => b.textContent)).toEqual(['Saiba mais']);
    expect(buttons[0]?.getAttribute('aria-label')).toBe('Saiba mais sobre MD009 (abre no navegador)');
    expect(buttons[0]?.dataset.action).toBe('learn-more');
    expect(document.activeElement).toBe(buttons[0]);
    buttons[0]?.click();
    expect(opened).toEqual(['https://github.com/DavidAnson/markdownlint/blob/v0.41.1/doc/md009.md']);
    expect(card(view)).not.toBeNull();
  });

  it('Esc fecha e devolve o foco ao editor com o cursor intacto; Tab depois do último também', () => {
    const { view } = lintView();
    const pos = view.state.doc.line(3).to - 1;
    view.dispatch({ selection: { anchor: pos } });
    runInteract(view);
    key(card(view) as HTMLElement, { key: 'Escape' });
    expect(card(view)).toBeNull();
    expect(view.state.selection.main.head).toBe(pos);
    expect(view.hasFocus).toBe(true);
    runInteract(view);
    const last = card(view)?.querySelector('button') as HTMLButtonElement;
    key(last, { key: 'Tab' });
    expect(card(view)).toBeNull();
    expect(view.state.selection.main.head).toBe(pos);
  });

  it('Tab/Shift-Tab circulam só pelos botões (cartão com 2 grupos, como o do LT)', () => {
    const { view } = lintView('palavra\n');
    const runs: string[] = [];
    view.dispatch(
      setDiagnostics(view.state, [
        problemDiagnostic(0, 7, {
          source: 'languagetool',
          kind: 'spelling',
          title: 'Ortografia',
          label: 'Ortografia',
          body: 'Possível erro.',
          footer: 'Regra MORFOLOGIK_RULE_PT_BR',
          actions: [
            { action: 'replace', label: 'Trocar por “palavras”', group: 1, run: () => runs.push('r') },
            { action: 'ignore', label: 'Ignorar', group: 2, run: () => runs.push('i') },
            {
              action: 'disable-rule',
              label: 'Desativar regra',
              name: 'Desativar regra MORFOLOGIK_RULE_PT_BR',
              group: 2,
              run: () => runs.push('d'),
            },
          ],
        }),
      ]),
    );
    view.dispatch({ selection: { anchor: 3 } });
    runInteract(view);
    const dialog = card(view) as HTMLElement;
    expect(dialog.dataset.source).toBe('languagetool');
    expect(dialog.querySelectorAll('.cm-problem-actions').length).toBe(2);
    expect(dialog.querySelector('.cm-problem-sep')).not.toBeNull();
    expect(dialog.querySelector('.cm-problem-footer')?.textContent).toBe('Regra MORFOLOGIK_RULE_PT_BR');
    const buttons = [...dialog.querySelectorAll('button')];
    expect(document.activeElement).toBe(buttons[0]);
    key(buttons[0] as HTMLElement, { key: 'Tab' });
    expect(document.activeElement).toBe(buttons[1]);
    key(buttons[1] as HTMLElement, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(buttons[0]);
    key(buttons[0] as HTMLElement, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(buttons[2]);
    (buttons[1] as HTMLButtonElement).click();
    expect(runs).toEqual(['i']);
    expect(card(view)).toBeNull();
  });

  it('sem problema sob o cursor: o alvo recusa (o próximo alvo tenta)', () => {
    const { view } = lintView();
    view.dispatch({ selection: { anchor: 0 } });
    expect(runInteract(view)).toBe(false);
    expect(card(view)).toBeNull();
  });
});

describe('AC-I5.5 painel W5 e próximo/anterior pelo teclado', () => {
  it('painel "Problemas": listbox rotulado, cabeçalho, "Fechar" com ícone, linhas só texto', () => {
    const { view } = lintView();
    problemsCommands.openPanel(view);
    const panel = view.dom.querySelector<HTMLElement>('.cm-panel-lint');
    expect(panel?.dataset.testid).toBe('problems-panel');
    const header = panel?.querySelector('.cm-problems-header');
    expect(header?.textContent).toBe('Problemas');
    expect(header?.getAttribute('aria-hidden')).toBe('true');
    const list = panel?.querySelector('ul');
    expect(list?.getAttribute('role')).toBe('listbox');
    expect(list?.getAttribute('aria-label')).toBe('Problemas');
    expect(document.activeElement).toBe(list);
    const close = panel?.querySelector('button[name=close]');
    expect(close?.getAttribute('aria-label')).toBe('Fechar');
    expect(close?.textContent).toBe('');
    expect(close?.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
    const options = [...(list?.querySelectorAll('[role=option]') ?? [])];
    expect(options.map((o) => o.textContent)).toEqual([
      'MD009 no-trailing-spaces: Espaços no fim da linha.',
      'MD009 no-trailing-spaces: Espaços no fim da linha.',
    ]);
    for (const option of options) expect(option.querySelector('button, a, [tabindex]')).toBeNull();
    expect(panel?.textContent).not.toMatch(/Corrigir/);
    // ↓ move a seleção para o próximo problema (teclado do próprio painel do CM).
    key(list as HTMLElement, { key: 'ArrowDown', keyCode: 40 } as KeyboardEventInit);
    expect(view.state.doc.lineAt(view.state.selection.main.from).number).toBe(5);
    closeLintPanel(view);
  });

  it('painel sem problemas: "Nenhum problema"', () => {
    const { view } = lintView('# Nota\n');
    problemsCommands.openPanel(view);
    expect(view.dom.querySelector('.cm-panel-lint [role=option]')?.textContent).toBe(
      'Nenhum problema',
    );
  });

  it('F8/Shift-F8 vão ao próximo/anterior com volta e anunciam "<rótulo>: <mensagem>. Linha <n>."', () => {
    const { view } = lintView();
    expect(problemsCommands.next(view)).toBe(true);
    expect(view.state.doc.lineAt(view.state.selection.main.from).number).toBe(3);
    expect(lastAnnouncement(view)).toBe('MD009 no-trailing-spaces: Espaços no fim da linha. Linha 3.');
    problemsCommands.next(view);
    expect(view.state.doc.lineAt(view.state.selection.main.from).number).toBe(5);
    problemsCommands.next(view);
    expect(view.state.doc.lineAt(view.state.selection.main.from).number).toBe(3);
    problemsCommands.prev(view);
    expect(view.state.doc.lineAt(view.state.selection.main.from).number).toBe(5);
    expect(lastAnnouncement(view)).toBe('MD009 no-trailing-spaces: Espaços no fim da linha. Linha 5.');
  });

  it('o keymap liga Mod-Shift-m, F8 e Shift-F8 (registrado uma vez)', () => {
    const { view } = lintView();
    key(view.contentDOM, { key: 'F8' });
    expect(view.state.doc.lineAt(view.state.selection.main.from).number).toBe(3);
    key(view.contentDOM, { key: 'M', keyCode: 77, ctrlKey: true, shiftKey: true } as KeyboardEventInit);
    expect(view.dom.querySelector('.cm-panel-lint')).not.toBeNull();
  });
});
