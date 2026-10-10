import { redo, undo } from '@codemirror/commands';
import { EditorState } from '@codemirror/state';
import { runContextChain } from '@simplemd/core';
import { afterEach, describe, expect, test } from 'vitest';
import { runSnippetChain } from '../src/latex-snippets/cm/keydown';
import { activeSession } from '../src/latex-snippets/cm/tabstops';
import { expandCommand } from '../src/latex-snippets/keys';
import { destroyLatexViews, keydown, mountLatex, show, type } from './latex';

/**
 * r7 S6 — I-6 Snippets LaTeX (porte do obsidian-latex-suite 1.9.8). AC-I6.1 (tabela do conjunto
 * padrão), AC-I6.2 (opções), AC-I6.3 (fração, matriz, delimitadores), AC-I6.4 (paradas, VT do
 * comportamento; o PW fica no harness) e AC-I6.6 (IME e desfazer).
 */
afterEach(destroyLatexViews);

const INLINE = '$|$';
const BLOCK = '$$\n|\n$$';

/** [gatilho digitado, resultado esperado dentro de `$…$` (| = cursor, [..] = seleção)]. */
const INLINE_TABLE: readonly [string, string][] = [
  ['@a', '$\\alpha|$'],
  ['@b', '$\\beta|$'],
  ['@G', '$\\Gamma|$'],
  [':e', '$\\varepsilon|$'],
  ['ome', '$\\omega|$'],
  ['xsr', '$x^{2}|$'],
  ['xcb', '$x^{3}|$'],
  ['xrd', '$x^{|}$'],
  ['x_', '$x_{|}$'],
  ['sq', '$\\sqrt{ | }$'],
  ['//', '$\\frac{|}{}$'],
  ['ee', '$e^{ | }$'],
  ['Ainvs', '$A^{-1}|$'],
  ['x2', '$x_{2}|$'],
  ['Re', '$\\mathrm{Re}|$'],
  ['bf', '$\\mathbf{|}$'],
  ['xhat', '$\\hat{x}|$'],
  ['ooo', '$\\infty|$'],
  ['+-', '$\\pm|$'],
  ['...', '$\\dots|$'],
  ['axxb', '$a\\times b|$'],
  ['!=', '$\\neq|$'],
  ['<=', '$\\leq|$'],
  ['->', '$\\to|$'],
  ['=>', '$\\implies|$'],
  ['inn', '$\\in|$'],
  ['RR', '$\\mathbb{R}|$'],
  ['alpha', '$\\alpha|$'],
  ['sum', '$\\sum|$'],
  ['lim', '$\\lim_{ [n] \\to \\infty }$'],
  ['pmat', '$\\begin{pmatrix}|\\end{pmatrix}$'],
  ['dint', '$\\int_{[0]}^{1}  \\, dx$'],
  ['avg', '$\\langle | \\rangle$'],
  ['(', '$(|)$'],
  ['set', '$\\{ | \\}$'],
  ['ddt', '$\\frac{d}{dt}|$'],
  ['sin', '$\\sin|$'],
  ['ket', '$\\ket{|}$'],
];

/** [gatilho, resultado dentro de um bloco `$$`]. */
const BLOCK_TABLE: readonly [string, string][] = [
  ['@a', '$$\n\\alpha|\n$$'],
  ['xsr', '$$\nx^{2}|\n$$'],
  ['//', '$$\n\\frac{|}{}\n$$'],
  ['pmat', '$$\n\\begin{pmatrix}\n|\n\\end{pmatrix}\n$$'],
  ['iden2', '$$\n\\begin{pmatrix}\n1 & 0 \\\\\n0 & 1\n\\end{pmatrix}|\n$$'],
  ['cases', '$$\n\\begin{cases}\n|\n\\end{cases}\n$$'],
  ['sq', '$$\n\\sqrt{ | }\n$$'],
];

describe('AC-I6.1 conjunto padrão (≥ 30 snippets) dentro de $…$ e $$…$$', () => {
  test('a tabela cobre pelo menos 30 snippets distintos', () => {
    expect(new Set([...INLINE_TABLE, ...BLOCK_TABLE].map(([t]) => t)).size).toBeGreaterThanOrEqual(
      30,
    );
  });

  test.each(INLINE_TABLE)('em linha: %s → %s', (trigger, expected) => {
    const { view } = mountLatex(INLINE);
    type(view, trigger);
    expect(show(view)).toBe(expected);
  });

  test.each(BLOCK_TABLE)('em bloco: %s → %s', (trigger, expected) => {
    const { view } = mountLatex(BLOCK);
    type(view, trigger);
    expect(show(view)).toBe(expected);
  });

  test('iden1…iden6 (Q-R7-F07): matriz identidade n × n como dados', () => {
    const { view } = mountLatex(BLOCK);
    type(view, 'iden3');
    expect(view.state.doc.toString()).toBe(
      '$$\n\\begin{pmatrix}\n1 & 0 & 0 \\\\\n0 & 1 & 0 \\\\\n0 & 0 & 1\n\\end{pmatrix}\n$$',
    );
  });

  test('$ ainda sem fechamento (digitação): `$@a` vira `$\\alpha` (D-R7-S6-01)', () => {
    const { view } = mountLatex('Seja |');
    type(view, '$@a');
    expect(show(view)).toBe('Seja $\\alpha|');
  });
});

describe('AC-I6.2 opções do motor', () => {
  test('m: não expande fora de matemática', () => {
    const { view } = mountLatex('texto |');
    type(view, '@a sum ->');
    expect(show(view)).toBe('texto @a sum ->|');
  });

  test('t: `mk` só no texto; dentro de $…$ fica literal', () => {
    const text = mountLatex('a |');
    type(text.view, 'mk');
    expect(show(text.view)).toBe('a $|$');
    const math = mountLatex('$x |$');
    type(math.view, 'mk');
    expect(show(math.view)).toBe('$x mk|$');
  });

  test('M/n: `pmat` em bloco quebra linhas; em linha não', () => {
    const block = mountLatex(BLOCK);
    type(block.view, 'pmat');
    expect(block.view.state.doc.toString()).toContain('\\begin{pmatrix}\n\n\\end{pmatrix}');
    const inline = mountLatex(INLINE);
    type(inline.view, 'pmat');
    expect(inline.view.state.doc.toString()).toBe('$\\begin{pmatrix}\\end{pmatrix}$');
  });

  test('w: `dm` só em limite de palavra', () => {
    const word = mountLatex('ad|');
    type(word.view, 'm');
    expect(word.view.state.doc.toString()).toBe('adm');
    const start = mountLatex('|');
    type(start.view, 'dm');
    expect(show(start.view)).toBe('$$\n|\n$$');
  });

  test('r: grupos [[0]] e [[1]] (`([A-Za-z])(\\d)` → `x_{2}`; `xhat` → `\\hat{x}`)', () => {
    const { view } = mountLatex(INLINE);
    type(view, 'y3+zhat');
    expect(show(view)).toBe('$y_{3}+\\hat{z}|$');
  });

  test('v: com seleção, `S` envolve a seleção', () => {
    const { view } = mountLatex('$[a+b]$');
    type(view, 'S');
    expect(show(view)).toBe('$\\sqrt{ a+b }|$');
  });

  test.each([
    ['código cercado', '```\n$|$\n```'],
    ['código em linha', '`$x|$`'],
    ['bloco indentado', '    $x|$'],
    ['front matter', '---\ntitulo: $x|$\n---\n\ntexto'],
    ['bloco HTML', '<div>\n$x|$\n</div>'],
  ])('nada expande em %s', (_name, doc) => {
    const { view } = mountLatex(doc);
    const before = view.state.doc.toString();
    type(view, '@a');
    expect(view.state.doc.toString()).toBe(before.replace('$x$', '$x@a$').replace('$$', '$@a$'));
    expect(view.state.doc.toString()).not.toContain('\\alpha');
  });

  test('nem `mk` (texto) dentro de uma tag HTML', () => {
    const { view } = mountLatex('<span title="|">x</span>');
    type(view, 'mk');
    expect(view.state.doc.toString()).toBe('<span title="mk">x</span>');
  });

  test('dentro de \\text{…} valem os snippets de texto, não os de matemática', () => {
    const { view } = mountLatex('$\\text{|}$');
    type(view, '@a');
    expect(view.state.doc.toString()).toBe('$\\text{@a}$');
  });
});

describe('AC-I6.3 fração automática, matriz e delimitadores (cada um desligável)', () => {
  test.each([
    ['x/', '$\\frac{x}{|}$'],
    ['(a+b)/', '$\\frac{a+b}{|}$'],
    ['\\pi/', '$\\frac{\\pi}{|}$'],
    ['2^{n}/', '$\\frac{2^{n}}{|}$'],
    ['a+x/', '$a+\\frac{x}{|}$'],
  ])('fração: %s → %s', (typed, expected) => {
    const { view } = mountLatex(INLINE);
    // `(`, `{` e `^` abririam snippets/pares; o termo já escrito entra direto.
    view.dispatch(view.state.replaceSelection(typed.slice(0, -1)));
    type(view, '/');
    expect(show(view)).toBe(expected);
  });

  test('fração desligada: `x/` fica `x/`', () => {
    const { view } = mountLatex(INLINE, { autofraction: false });
    type(view, 'x/');
    expect(show(view)).toBe('$x/|$');
  });

  test('matriz: Enter → ` \\\\ ` em linha e ` \\\\` + nova linha em bloco', () => {
    const inline = mountLatex('$\\begin{pmatrix}1|\\end{pmatrix}$');
    type(inline.view, '\n');
    expect(show(inline.view)).toBe('$\\begin{pmatrix}1 \\\\ |\\end{pmatrix}$');
    const block = mountLatex('$$\n\\begin{bmatrix}\n1|\n\\end{bmatrix}\n$$');
    type(block.view, '\n');
    expect(show(block.view)).toBe('$$\n\\begin{bmatrix}\n1 \\\\\n|\n\\end{bmatrix}\n$$');
  });

  test('matriz desligada: Enter segue para o editor (sem ` \\\\ `)', () => {
    const { view } = mountLatex('$\\begin{pmatrix}1|\\end{pmatrix}$', { matrixShortcuts: false });
    keydown(view, { key: 'Enter' });
    expect(view.state.doc.toString()).not.toContain('\\\\');
  });

  test('delimitadores: `(…)` com \\frac vira \\left( … \\right)', () => {
    const { view } = mountLatex('$(x|)$');
    type(view, '/');
    expect(show(view)).toBe('$\\left( \\frac{x}{|} \\right)$');
  });

  test('delimitadores desligados: ficam como estão', () => {
    const { view } = mountLatex('$(x|)$', { autoEnlargeBrackets: false });
    type(view, '/');
    expect(show(view)).toBe('$(\\frac{x}{|})$');
  });

  test('tabout (chave Tab): sai do par; desligado segue a cadeia', () => {
    const on = mountLatex('$\\sqrt{x|}$', { captureTab: true });
    expect(keydown(on.view, { key: 'Tab' }).defaultPrevented).toBe(true);
    expect(show(on.view)).toBe('$\\sqrt{x}|$');
    const off = mountLatex('$\\sqrt{x|}$', { captureTab: true, tabout: false });
    keydown(off.view, { key: 'Tab' });
    expect(off.view.state.doc.toString()).not.toBe('$\\sqrt{x}$');
  });

  test('matriz com a chave Tab: Tab → ` & `', () => {
    const { view } = mountLatex('$\\begin{pmatrix}1|\\end{pmatrix}$', { captureTab: true });
    keydown(view, { key: 'Tab' });
    expect(show(view)).toBe('$\\begin{pmatrix}1 & |\\end{pmatrix}$');
  });
});

describe('AC-I6.4 paradas (comportamento; o PW roda no harness)', () => {
  test('chave ligada: Tab/Shift-Tab percorrem as paradas; Esc encerra e anuncia', () => {
    const { view, announced } = mountLatex(INLINE, { captureTab: true });
    type(view, 'dint');
    expect(show(view)).toBe('$\\int_{[0]}^{1}  \\, dx$');
    expect(announced.at(-1)).toBe(
      'Campo 1 de 5. Tab ou Command+Option+Seta para a direita vai ao próximo; Esc encerra.',
    );
    expect(view.dom.querySelectorAll('.cm-ltx-stop').length).toBeGreaterThan(0);
    expect(keydown(view, { key: 'Tab' }).defaultPrevented).toBe(true);
    expect(show(view)).toBe('$\\int_{0}^{[1]}  \\, dx$');
    expect(announced.at(-1)).toBe('Campo 2 de 5');
    keydown(view, { key: 'Tab', shiftKey: true });
    expect(show(view)).toBe('$\\int_{[0]}^{1}  \\, dx$');
    expect(keydown(view, { key: 'Escape' }).defaultPrevented).toBe(true);
    expect(activeSession(view.state)).toBeNull();
    expect(announced.at(-1)).toBe('Campos encerrados.');
    expect(view.dom.querySelectorAll('.cm-ltx-stop, .cm-ltx-stop-empty').length).toBe(0);
  });

  test('chave desligada: Tab não é capturado; Mod-Alt-→/← percorrem', () => {
    const { view, announced } = mountLatex(INLINE);
    type(view, '//');
    expect(announced.at(-1)).toBe(
      'Campo 1 de 3. Command+Option+Seta para a direita vai ao próximo; Esc encerra.',
    );
    expect(keydown(view, { key: 'Tab' }).defaultPrevented).toBe(false);
    // Teclas reais (jsdom não é macOS: Mod = Ctrl): Ctrl+Alt+→/← pela cadeia do núcleo.
    const right = { key: 'ArrowRight', keyCode: 39, ctrlKey: true, altKey: true };
    const left = { key: 'ArrowLeft', keyCode: 37, ctrlKey: true, altKey: true };
    expect(keydown(view, right).defaultPrevented).toBe(true);
    expect(show(view)).toBe('$\\frac{}{|}$');
    expect(keydown(view, left).defaultPrevented).toBe(true);
    expect(show(view)).toBe('$\\frac{|}{}$');
    runContextChain(view, 1, 'move');
    runContextChain(view, 1, 'move');
    expect(show(view)).toBe('$\\frac{}{}|$');
    expect(activeSession(view.state)).toBeNull();
  });

  test('sair da região com o cursor encerra as paradas', () => {
    const { view } = mountLatex('a $|$');
    type(view, '//');
    view.dispatch({ selection: { anchor: 0 } });
    expect(activeSession(view.state)).toBeNull();
  });

  test('digitar dentro da parada mantém a sessão; a parada vazia pendente é um widget aria-hidden', () => {
    const { view } = mountLatex(INLINE);
    type(view, '//');
    const empty = view.dom.querySelector('.cm-ltx-stop-empty');
    expect(empty?.getAttribute('aria-hidden')).toBe('true');
    type(view, 'ab');
    expect(activeSession(view.state)?.active).toBe(0);
    runContextChain(view, 1, 'move');
    expect(show(view)).toBe('$\\frac{ab}{|}$');
  });

  test('"Expandir snippet LaTeX" expande snippet não automático; sem gatilho anuncia', () => {
    const { view, announced } = mountLatex('$\\sum|$');
    expandCommand(view);
    expect(show(view)).toBe('$\\sum_{[i]=1}^{N}$');
    const none = mountLatex('$x|$');
    expect(expandCommand(none.view)).toBe(true);
    expect(none.announced.at(-1)).toBe('Nenhum snippet LaTeX para expandir aqui.');
    expect(announced.length).toBeGreaterThan(0);
  });

  test('Tab (chave ligada) expande snippet não automático', () => {
    const { view } = mountLatex('$\\int|$', { captureTab: true });
    keydown(view, { key: 'Tab' });
    expect(show(view)).toBe('$\\int | \\, dx$');
  });

  test('Mod-Shift-E liga o comando no editor', () => {
    const { view } = mountLatex('$\\prod|$');
    keydown(view, { key: 'E', keyCode: 69, ctrlKey: true, shiftKey: true });
    expect(view.state.doc.toString()).toBe('$\\prod_{i=1}^{N}$');
  });
});

describe('AC-I6.6 IME e desfazer', () => {
  test.each([
    ['isComposing', { isComposing: true }],
    ['keyCode 229', { keyCode: 229 }],
  ])('composição (%s) com $ aberto não expande', (_name, init) => {
    const { view } = mountLatex('$@|');
    const event = keydown(view, { key: 'a', ...init });
    expect(event.defaultPrevented).toBe(false);
    expect(view.state.doc.toString()).toBe('$@');
  });

  test('Mod-Z logo após uma expansão devolve o texto do gatilho; refazer restaura as paradas', () => {
    const { view } = mountLatex(INLINE);
    type(view, '@a');
    expect(show(view)).toBe('$\\alpha|$');
    undo(view);
    expect(show(view)).toBe('$@a|$');
    const fraction = mountLatex(INLINE);
    type(fraction.view, 'x/');
    undo(fraction.view);
    expect(show(fraction.view)).toBe('$x/|$');
    expect(activeSession(fraction.view.state)).toBeNull();
    redo(fraction.view);
    expect(fraction.view.state.doc.toString()).toBe('$\\frac{x}{}$');
    expect(activeSession(fraction.view.state)?.groups.length).toBe(2);
  });
});

describe('CR-S6-09 teclas: só leitura e AltGr', () => {
  test('documento só leitura: digitação, cadeia do Tab e comando não expandem', () => {
    const { view } = mountLatex('$@|$', { extra: [EditorState.readOnly.of(true)] });
    expect(keydown(view, { key: 'a' }).defaultPrevented).toBe(false);
    expect(runSnippetChain(view, 1, 'tab')).toBe(false);
    expect(expandCommand(view)).toBe(false);
    expect(view.state.doc.toString()).toBe('$@$');
  });

  test('fora do macOS, AltGr (Ctrl+Alt) é digitação e expande; Ctrl sozinho não', () => {
    const altGr = { key: 'a', ctrlKey: true, altKey: true, modifierAltGraph: true };
    const other = mountLatex('$@|$', { platform: 'other' });
    expect(keydown(other.view, altGr).defaultPrevented).toBe(true);
    expect(show(other.view)).toBe('$\\alpha|$');
    // Ctrl+A é do núcleo (selecionar tudo); o que importa é o snippet não expandir.
    const ctrl = mountLatex('$@|$', { platform: 'other' });
    keydown(ctrl.view, { key: 'a', ctrlKey: true });
    expect(ctrl.view.state.doc.toString()).toBe('$@$');
    const mac = mountLatex('$@|$');
    keydown(mac.view, altGr);
    expect(mac.view.state.doc.toString()).toBe('$@$');
  });
});
