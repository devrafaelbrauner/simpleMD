// @vitest-environment jsdom
import { Prec, type Extension } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  appPlatformFacet,
  EditorHost,
  EMPTY_CONTRIBUTIONS,
  resetTabFocus,
  TAB_HELP_ID,
  tabFocusMode,
  tabFocusObserver,
} from '../src';

/**
 * r7 ST — WCAG 2.1.2 (AC-X7.2, AC-X7.3, arch-ux §6.1): com a "Tecla Tab no editor" desligada o
 * editor nunca prende a Tab; ligada, cada uma das saídas deixa o Tab ao navegador (o evento NÃO é
 * cancelado e nenhum keymap roda), que é o que move o foco para fora do `.cm-content`.
 */
const views: EditorView[] = [];
afterEach(() => {
  while (views.length) views.pop()?.destroy();
  vi.restoreAllMocks();
});

function mount(
  captureTab: boolean,
  doc = 'abc',
  platform: 'mac' | 'other' = 'other',
  extra: Extension[] = [],
) {
  const host = new EditorHost(
    { ...EMPTY_CONTRIBUTIONS, captureTab, pluginExtensions: extra },
    appPlatformFacet.of(platform),
  );
  const parent = document.createElement('div');
  document.body.append(parent);
  const view = new EditorView({ state: host.createState(doc), parent });
  view.dispatch({ selection: { anchor: doc.length } });
  views.push(view);
  return { view, host };
}

function key(view: EditorView, init: KeyboardEventInit & { keyCode?: number; code?: string }) {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  if (init.keyCode !== undefined) Object.defineProperty(event, 'keyCode', { value: init.keyCode });
  view.contentDOM.dispatchEvent(event);
  return event;
}
const TAB = { key: 'Tab', code: 'Tab', keyCode: 9 };
const ESC = { key: 'Escape', code: 'Escape', keyCode: 27 };
const CTRL_M = { key: 'm', code: 'KeyM', keyCode: 77, ctrlKey: true };
const ALT_SHIFT_M = { key: 'Â', code: 'KeyM', keyCode: 77, altKey: true, shiftKey: true };

const announced = (view: EditorView) => view.dom.querySelector('.cm-announced')?.textContent ?? '';

describe('T0: chave desligada (AC-X7.2)', () => {
  test('Tab e Shift-Tab nunca são capturados: o evento segue para o navegador', () => {
    const { view } = mount(false);
    expect(key(view, TAB).defaultPrevented).toBe(false);
    expect(key(view, { ...TAB, shiftKey: true }).defaultPrevented).toBe(false);
    expect(view.state.doc.toString()).toBe('abc');
    expect(view.contentDOM.hasAttribute('aria-describedby')).toBe(false);
  });
});

describe('T1/T2: chave ligada (AC-X7.3, WCAG 2.1.2)', () => {
  test('T1: Tab indenta (evento consumido) e o conteúdo é descrito por smd-editor-tab-help', () => {
    const { view } = mount(true);
    expect(key(view, TAB).defaultPrevented).toBe(true);
    expect(view.state.doc.toString()).toBe('abc  ');
    expect(view.contentDOM.getAttribute('aria-describedby')).toBe(TAB_HELP_ID);
  });

  test('saída (a): Ctrl-M alterna para T2 e anuncia; Tab passa ao navegador; Ctrl-M volta', () => {
    const modes: string[] = [];
    // O observador fica no estado do editor (CR-ST-13): nada a desassinar no fim.
    const { view } = mount(true, 'abc', 'other', [
      tabFocusObserver.of((_v, mode) => modes.push(mode)),
    ]);
    expect(key(view, CTRL_M).defaultPrevented).toBe(true);
    expect(tabFocusMode(view)).toBe('focus');
    expect(announced(view)).toBe('Tab move o foco');
    const tab = key(view, TAB);
    expect(tab.defaultPrevented).toBe(false);
    expect(view.state.doc.toString()).toBe('abc');
    key(view, CTRL_M);
    expect(tabFocusMode(view)).toBe('indent');
    expect(announced(view)).toBe('Tab indenta');
    expect(key(view, TAB).defaultPrevented).toBe(true);
    expect(modes).toEqual(['focus', 'indent']);
  });

  test('saída (a) no macOS: ⌥⇧M (que gera "Â") alterna; Ctrl-M não', () => {
    const { view } = mount(true, 'abc', 'mac');
    key(view, CTRL_M);
    expect(tabFocusMode(view)).toBe('indent');
    key(view, ALT_SHIFT_M);
    expect(tabFocusMode(view)).toBe('focus');
    expect(key(view, TAB).defaultPrevented).toBe(false);
  });

  test('o alternador vence um keydown Prec.highest de plugin (Vim) montado depois', () => {
    const vim = vi.fn(() => true);
    const { view } = mount(true, 'abc', 'other', [
      Prec.highest(EditorView.domEventHandlers({ keydown: vim })),
    ] as never);
    key(view, CTRL_M);
    expect(tabFocusMode(view)).toBe('focus');
    expect(vim).not.toHaveBeenCalled();
  });

  test('saída (b): Esc e Tab em até 2 s sai; depois de 2 s o Tab volta a indentar', () => {
    const { view } = mount(true);
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    key(view, ESC);
    now += 1_900;
    expect(key(view, TAB).defaultPrevented).toBe(false);
    expect(view.state.doc.toString()).toBe('abc');
    key(view, ESC);
    now += 2_500;
    expect(key(view, TAB).defaultPrevented).toBe(true);
    expect(view.state.doc.toString()).toBe('abc  ');
  });

  test('saída (b) arma mesmo quando um dono (Vim/paradas) consome o Escape antes', () => {
    const owner = Prec.highest(
      EditorView.domEventHandlers({ keydown: (event) => event.key === 'Escape' }),
    );
    const { view } = mount(true, 'abc', 'other', [owner] as never);
    vi.spyOn(Date, 'now').mockReturnValue(5_000);
    key(view, ESC);
    expect(key(view, TAB).defaultPrevented).toBe(false);
  });

  test('primeira entrada de foco anuncia a descrição uma vez; resetTabFocus rearma', async () => {
    const { view } = mount(true);
    resetTabFocus(view);
    view.contentDOM.dispatchEvent(new FocusEvent('focus'));
    await Promise.resolve();
    expect(announced(view)).toBe('Tab indenta. Para sair do editor: Esc e depois Tab, ou Ctrl+M.');
    view.dispatch({ effects: EditorView.announce.of('outro') });
    view.contentDOM.dispatchEvent(new FocusEvent('focus'));
    await Promise.resolve();
    expect(announced(view)).toBe('outro');
  });

  test('desligar a chave reconfigura sem recriar o view: Tab volta a sair', () => {
    const { view, host } = mount(true);
    view.dispatch({ effects: host.update({ captureTab: false }) });
    expect(key(view, TAB).defaultPrevented).toBe(false);
    expect(view.contentDOM.hasAttribute('aria-describedby')).toBe(false);
    expect(
      view.state
        .facet(keymap)
        .flat()
        .some((b) => b.key === 'Tab'),
    ).toBe(false);
  });
});
