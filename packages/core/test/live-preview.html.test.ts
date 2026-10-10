// @vitest-environment jsdom
// I-10 no editor (R-I10.2/R-I10.3, AC-I10.4 em VT, NFR-41): widget de bloco e em linha, revelação,
// lista fechada de transformações (DA-R7-18), STR-178, Mod-clique, "Interagir" e 0 re-sanitizações
// ao digitar fora dos blocos HTML.
import { EditorState, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  appPlatformFacet,
  createMarkdownExtensions,
  imageSourceFacet,
  linkOpenerFacet,
  liveCounters,
  noteContext,
  runInteract,
  setEditorFocus,
  type ImageSource,
  type LinkOpener,
  type LinkTarget,
} from '../src';
import { HtmlWidget, inlineHtmlGroups } from '../src/live-preview/html';
import { HTML_ADVERSARIAL } from '../src/testing/html-adversarial';
import { decorate, fullyParsed, previewState } from './helpers/live-preview';

const views: EditorView[] = [];
afterEach(() => {
  while (views.length) views.pop()?.destroy();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

function mount(doc: string, extensions: Extension[] = [], anchor = doc.length): EditorView {
  const parent = document.body.appendChild(document.createElement('div'));
  const state = EditorState.create({
    doc,
    selection: { anchor },
    extensions: [
      createMarkdownExtensions(),
      noteContext.of({ path: 'notas/html.md' }),
      ...extensions,
    ],
  });
  const view = new EditorView({ state, parent });
  views.push(view);
  return fullyParsed(view);
}

function spyOpener(): LinkOpener & { opened: LinkTarget[] } {
  const opened: LinkTarget[] = [];
  return { opened, open: (target) => void opened.push(target), noLink: () => {} };
}

const htmlWidgets = (state: EditorState) =>
  [...decorate(state).inline, ...decorate(state).block]
    .filter((d) => d.widget instanceof HtmlWidget)
    .sort((a, b) => a.from - b.from);

const DOC = [
  '# Nota',
  '',
  '<details>',
  '<summary>Resumo</summary>',
  '<p>corpo <a href="https://exemplo.org/a">link</a> <mark>marcado <a href="outra.md">nota</a></mark></p>',
  '</details>',
  '',
  'Teclas <kbd>Ctrl</kbd>+<kbd>C</kbd>, <mark>x</mark>, quebra<br>linha e <b>solta.',
  '',
  '<script>window.__xss = 1</script>',
  '',
  '<details><p>sem resumo</p></details>',
  '',
  '<p><img src="../img/a.png" alt="do vault"> <img src="https://evil.example/x.png" alt="remota"></p>',
  '',
  '</details>',
  '',
  'fim',
].join('\n');

describe('R-I10.2 decorações (puras)', () => {
  it('bloco de topo → widget de bloco; tags em linha balanceadas → widgets em linha; desbalanceada crua', () => {
    const state = previewState(DOC, { anchor: DOC.length, focus: false });
    const widgets = htmlWidgets(state).map((d) => {
      const w = d.widget as HtmlWidget;
      return [w.block, w.source] as const;
    });
    expect(widgets).toEqual([
      [
        true,
        '<details>\n<summary>Resumo</summary>\n<p>corpo <a href="https://exemplo.org/a">link</a> <mark>marcado <a href="outra.md">nota</a></mark></p>\n</details>',
      ],
      [false, '<kbd>Ctrl</kbd>'],
      [false, '<kbd>C</kbd>'],
      [false, '<mark>x</mark>'],
      [false, '<br>'],
      [true, '<script>window.__xss = 1</script>'],
      [true, '<details><p>sem resumo</p></details>'],
      [
        true,
        '<p><img src="../img/a.png" alt="do vault"> <img src="https://evil.example/x.png" alt="remota"></p>',
      ],
    ]);
    // `<b>solta.` sem fechamento e o `</details>` solto ficam crus (nenhum widget).
  });

  it('cursor dentro (com foco) → cru; sem foco → widget', () => {
    const inside = DOC.indexOf('Resumo');
    expect(
      htmlWidgets(previewState(DOC, { anchor: inside })).some(
        (d) => d.from === DOC.indexOf('<details>'),
      ),
    ).toBe(false);
    expect(
      htmlWidgets(previewState(DOC, { anchor: inside, focus: false })).some(
        (d) => d.from === DOC.indexOf('<details>'),
      ),
    ).toBe(true);
    const kbd = DOC.indexOf('Ctrl');
    const touched = htmlWidgets(previewState(DOC, { anchor: kbd })).map(
      (d) => (d.widget as HtmlWidget).source,
    );
    expect(touched).not.toContain('<kbd>Ctrl</kbd>');
    expect(touched).toContain('<kbd>C</kbd>');
  });

  it('grupos: pilha por nome; trocado, fora da política ou aberto → cru', () => {
    const groups = (text: string) => {
      const state = previewState(text, { focus: false });
      return htmlWidgets(state).map((d) => (d.widget as HtmlWidget).source);
    };
    expect(groups('a <b><i>x</i></b> c')).toEqual(['<b><i>x</i></b>']);
    expect(groups('a <b><i>x</b></i> c')).toEqual([]);
    expect(groups('a <b>x <blink>y</blink></b> c')).toEqual([]);
    expect(groups('a <blink>y</blink> c')).toEqual([]);
    expect(groups('a </b> <b>x')).toEqual([]);
    expect(groups('a <span/>x</span> b')).toEqual(['<span/>x</span>']);
    expect(groups('a <!-- c --> <img src="a.png"> b')).toEqual(['<img src="a.png">']);
    expect(groups('*<mark>y</mark>* e <sub>2</sub>')).toEqual(['<mark>y</mark>', '<sub>2</sub>']);
    expect(groups('```\n<kbd>x</kbd>\n```')).toEqual([]);
    expect(groups('`<kbd>x</kbd>`')).toEqual([]);
  });

  it('grupos lidos dos filhos diretos do contêiner (ênfase, título)', () => {
    const state = previewState('# T <kbd>a</kbd>\n\n**<mark>b</mark>**', { focus: false });
    expect(htmlWidgets(state).map((d) => (d.widget as HtmlWidget).source)).toEqual([
      '<kbd>a</kbd>',
      '<mark>b</mark>',
    ]);
    expect(inlineHtmlGroups).toBeTypeOf('function');
  });
});

describe('R-I10.2/R-I10.3 widget montado (lista fechada DA-R7-18)', () => {
  it('a → span.cm-md-link[role=link] sem href; mark/kbd com classe; summary tabindex=-1; 0 a/[href] no conteúdo', () => {
    const view = mount(DOC);
    const content = view.contentDOM;
    expect(content.querySelector('a, [href]')).toBeNull();
    const block = content.querySelector<HTMLElement>('[data-testid=html-widget]');
    expect(block?.className).toBe('cm-md-html');
    const links = [...block!.querySelectorAll('.cm-md-link')];
    expect(
      links.map((l) => [
        l.getAttribute('role'),
        l.getAttribute('tabindex'),
        l.getAttribute('data-href'),
        l.getAttribute('aria-label'),
      ]),
    ).toEqual([
      ['link', '-1', 'https://exemplo.org/a', 'link (link: https://exemplo.org/a)'],
      ['link', '-1', 'notas/outra.md', 'nota (nota: notas/outra.md)'],
    ]);
    expect(block!.querySelector('mark')?.className).toBe('cm-md-mark');
    expect(block!.querySelector('summary')?.getAttribute('tabindex')).toBe('-1');
    expect([...content.querySelectorAll('kbd')].map((k) => k.className)).toEqual([
      'cm-md-kbd',
      'cm-md-kbd',
    ]);
    expect(content.querySelectorAll('[data-testid=html-inline]').length).toBe(4);
    // As únicas classes no conteúdo vieram das transformações.
    for (const el of content.querySelectorAll('.cm-md-html *, .cm-md-html-inline *')) {
      if (el.closest('[data-testid=cm-image]')) continue;
      for (const cls of el.classList)
        expect(['cm-md-link', 'cm-md-mark', 'cm-md-kbd', 'cm-md-html-empty']).toContain(cls);
    }
  });

  it('saída vazia → STR-178 em muted; <details> sem summary → "Detalhes"', () => {
    const view = mount(DOC);
    const empty = view.contentDOM.querySelector('.cm-md-html-empty');
    expect(empty?.textContent).toBe('HTML sem conteúdo exibível (removido por segurança).');
    const summaries = [...view.contentDOM.querySelectorAll('summary')].map((s) => s.textContent);
    expect(summaries).toEqual(['Resumo', 'Detalhes']);
  });

  it('<img> do vault pelo pipeline de imagens (blob:); remota → alt em muted, 0 pedidos remotos', () => {
    const requests: string[] = [];
    const images: ImageSource = {
      request(path) {
        requests.push(path);
        return { state: { kind: 'ok', url: `blob:fake/${path}` }, subscribe: () => () => {} };
      },
    };
    const view = mount(DOC, [imageSourceFacet.of(images)]);
    expect(requests).toEqual(['img/a.png']);
    const shown = view.contentDOM.querySelector<HTMLImageElement>(
      '.cm-md-html [data-testid=cm-image] img',
    );
    expect(shown?.getAttribute('src')).toBe('blob:fake/img/a.png');
    expect(shown?.alt).toBe('do vault');
    const alt = view.contentDOM.querySelector('.cm-md-html [data-smd-alt]');
    expect(alt?.textContent).toBe('remota');
    const srcs = [...view.contentDOM.querySelectorAll('img:not(.cm-widgetBuffer)')].map((i) =>
      i.getAttribute('src'),
    );
    expect(srcs).toEqual(['blob:fake/img/a.png']);
  });

  it('o widget desmontado cancela a assinatura das imagens', () => {
    const cancelled: string[] = [];
    const images: ImageSource = {
      request(path) {
        return { state: { kind: 'loading' }, subscribe: () => () => void cancelled.push(path) };
      },
    };
    const view = mount(DOC, [imageSourceFacet.of(images)]);
    const at = DOC.indexOf('<p><img');
    view.focus();
    view.dispatch({ selection: { anchor: at + 3 }, effects: setEditorFocus.of(true) });
    expect(cancelled).toEqual(['img/a.png']);
  });

  it('<details> abre/fecha só na vista (0 bytes) e o summary não move o cursor', () => {
    const view = mount(DOC);
    const before = view.state.doc.toString();
    const summary = view.contentDOM.querySelector<HTMLElement>('summary')!;
    const details = summary.parentElement as HTMLDetailsElement;
    const widget = new HtmlWidget('<details></details>', null, true);
    expect(widget.ignoreEvent(new MouseEvent('mousedown'))).toBe(false);
    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 });
    Object.defineProperty(down, 'target', { value: summary });
    expect(widget.ignoreEvent(down)).toBe(true);
    summary.click();
    expect(details.open).toBe(true);
    summary.click();
    expect(details.open).toBe(false);
    expect(view.state.doc.toString()).toBe(before);
  });
});

describe('U-3 links do HTML: ⌘/Ctrl-clique abre; clique simples não', () => {
  it('Ctrl-clique (fora do macOS) abre pelo serviço uma vez; clique simples não abre', () => {
    const opener = spyOpener();
    const view = mount(DOC, [linkOpenerFacet.of(opener), appPlatformFacet.of('other')]);
    const link = view.contentDOM.querySelector<HTMLElement>('.cm-md-html .cm-md-link')!;
    link.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
    expect(opener.opened).toEqual([]);
    const mod = new MouseEvent('mousedown', {
      bubbles: true,
      cancelable: true,
      button: 0,
      ctrlKey: true,
    });
    link.dispatchEvent(mod);
    expect(mod.defaultPrevented).toBe(true);
    expect(opener.opened).toEqual([{ kind: 'external', url: 'https://exemplo.org/a' }]);
  });

  it('⌘-clique no macOS; Ctrl-clique no macOS não abre; link .md vira nota', () => {
    const opener = spyOpener();
    const view = mount(DOC, [linkOpenerFacet.of(opener), appPlatformFacet.of('mac')]);
    const [, note] = view.contentDOM.querySelectorAll<HTMLElement>('.cm-md-html .cm-md-link');
    note!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, ctrlKey: true }));
    expect(opener.opened).toEqual([]);
    note!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, metaKey: true }));
    expect(opener.opened).toEqual([{ kind: 'note', path: 'notas/outra.md', heading: null }]);
  });
});

describe('UX-R7-D5 "Interagir" no W4 (Mod-Shift-Enter)', () => {
  it('cursor no bloco → o primeiro summary recebe o foco; setas, Enter/Espaço, Esc devolve ao editor', () => {
    const opener = spyOpener();
    const view = mount(DOC, [linkOpenerFacet.of(opener)], DOC.indexOf('Resumo'));
    view.focus();
    view.dispatch({ effects: setEditorFocus.of(true) });
    expect([...view.contentDOM.querySelectorAll('summary')].map((s) => s.textContent)).toEqual([
      'Detalhes',
    ]);
    expect(runInteract(view)).toBe(true);
    const summary = view.contentDOM.querySelector<HTMLElement>('summary')!;
    expect(document.activeElement).toBe(summary);
    const key = (target: HTMLElement, k: string) => {
      const event = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true });
      target.dispatchEvent(event);
      return event;
    };
    const details = summary.parentElement as HTMLDetailsElement;
    expect(key(summary, 'Enter').defaultPrevented).toBe(true);
    expect(details.open).toBe(true);
    key(summary, ' ');
    expect(details.open).toBe(false);
    key(summary, 'ArrowDown');
    const first = view.contentDOM.querySelectorAll<HTMLElement>('.cm-md-html .cm-md-link')[0]!;
    expect(document.activeElement).toBe(first);
    key(first, 'Enter');
    expect(opener.opened).toEqual([{ kind: 'external', url: 'https://exemplo.org/a' }]);
    key(first, 'End');
    key(document.activeElement as HTMLElement, 'Home');
    expect(document.activeElement).toBe(summary);
    key(summary, 'ArrowUp');
    expect(document.activeElement).toBe(summary);
    key(summary, 'x');
    key(summary, 'Escape');
    expect(view.state.selection.main.head).toBe(DOC.indexOf('<details>'));
    expect(view.hasFocus).toBe(true);
  });

  it('Tab sai para depois do bloco; bloco sem summary/link não captura a tecla', () => {
    const view = mount(DOC, [], DOC.indexOf('Resumo'));
    view.focus();
    view.dispatch({ effects: setEditorFocus.of(true) });
    expect(runInteract(view)).toBe(true);
    const summary = view.contentDOM.querySelector<HTMLElement>('summary')!;
    summary.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }),
    );
    const end = DOC.indexOf('</details>') + '</details>'.length + 1;
    expect(view.state.selection.main.head).toBe(end);
    view.dispatch({ selection: { anchor: DOC.indexOf('window.__xss') } });
    expect(runInteract(view)).toBe(false);
    view.dispatch({ selection: { anchor: DOC.indexOf('fim') } });
    expect(runInteract(view)).toBe(false);
  });
});

describe('NFR-41 / R-I10.6: 0 re-sanitizações ao digitar fora dos blocos HTML', () => {
  it('digitar em prosa não sanitiza; editar dentro do bloco sanitiza só ele', () => {
    const view = mount(DOC, [], DOC.indexOf('fim'));
    view.focus();
    const runs = () => liveCounters.sanitizeRuns;
    const before = runs();
    for (let i = 0; i < 20; i++) {
      const at = view.state.doc.length;
      view.dispatch({ changes: { from: at, insert: 'x' }, selection: { anchor: at + 1 } });
    }
    expect(runs()).toBe(before);
    const at = view.state.doc.toString().indexOf('sem resumo');
    view.dispatch({ changes: { from: at, insert: 'Z' } });
    expect(runs() - before).toBeLessThanOrEqual(1);
  });
});

describe('R-I10.3 vetores adversariais no editor (jsdom)', () => {
  // Em lotes: no jsdom o CodeMirror desenha só a primeira tela de um documento longo.
  const batches: string[][] = [];
  for (let i = 0; i < HTML_ADVERSARIAL.length; i += 6)
    batches.push(HTML_ADVERSARIAL.slice(i, i + 6));
  let rendered = 0;

  it.each(batches.map((b, i) => [i, b] as const))(
    'lote %i: 0 script, 0 on*, 0 a/[href], 0 src, 0 class/id/name da nota',
    (_, batch) => {
      const view = mount(`fim\n\n${batch.join('\n\n')}`, [], 0);
      view.dispatch({ effects: setEditorFocus.of(false) });
      const content = view.contentDOM;
      const widgets = content.querySelectorAll(
        '[data-testid=html-widget], [data-testid=html-inline]',
      );
      rendered += widgets.length;
      for (const widget of widgets) {
        for (const el of widget.querySelectorAll('*')) {
          // Glifo do estado da imagem do vault: desenhado pelo app (S1), não vem da nota.
          if (el.closest('[data-testid=cm-image]')) continue;
          expect([
            'script',
            'iframe',
            'object',
            'embed',
            'form',
            'input',
            'svg',
            'math',
            'style',
            'base',
            'meta',
            'link',
            'a',
          ]).not.toContain(el.localName);
          for (const { name } of el.attributes) {
            expect(name.startsWith('on')).toBe(false);
            expect(['href', 'src', 'srcset', 'id', 'name']).not.toContain(name);
          }
          for (const cls of el.classList)
            expect(['cm-md-link', 'cm-md-mark', 'cm-md-kbd', 'cm-md-html-empty']).toContain(cls);
        }
      }
      expect('__xss' in window).toBe(false);
    },
  );

  it('a suíte virou widgets (comentários/CDATA/instruções ficam crus: não são HTMLBlock)', () => {
    expect(rendered).toBeGreaterThanOrEqual(100);
  });
});
