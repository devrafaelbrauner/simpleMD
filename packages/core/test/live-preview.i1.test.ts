// @vitest-environment jsdom
import { createHash } from 'node:crypto';
import { undo } from '@codemirror/commands';
import { EditorState, type Extension, type Transaction } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createMarkdownExtensions,
  imageSourceFacet,
  noteContext,
  setEditorFocus,
  type ImageSource,
  type ImageState,
} from '../src';
import { ImageWidget } from '../src/live-preview/images/widget';
import { TaskCheckboxWidget } from '../src/live-preview/tasks';
import { toggleTaskCommand } from '../src/tasks/semantics';
import fixture from './fixtures/live-preview.md?raw';
import {
  decorate,
  decosIn,
  fullyParsed,
  previewState,
  type FlatDeco,
} from './helpers/live-preview';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const at = (needle: string, doc = fixture) => {
  const from = doc.indexOf(needle);
  if (from < 0) throw new Error(`fixture sem "${needle}"`);
  return { from, to: from + needle.length };
};

/** Decorações (em linha + bloco) que começam dentro do trecho. */
const decosOf = (needle: string, state: EditorState, doc = fixture): FlatDeco[] => {
  const { from, to } = at(needle, doc);
  return decosIn(state, from, to);
};
const linkMarks = (decos: FlatDeco[]) => decos.filter((d) => d.class === 'cm-md-link');

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
    extensions: [createMarkdownExtensions(), ...extensions],
  });
  const view = new EditorView({ state, parent });
  views.push(view);
  return fullyParsed(view);
}

/** Cache falsa: toda imagem fica pronta com `blob:fake/<caminho>`; registra os pedidos. */
function fakeImages(): ImageSource & { requests: string[] } {
  const requests: string[] = [];
  return {
    requests,
    request(path) {
      requests.push(path);
      const state: ImageState = { kind: 'ok', url: `blob:fake/${encodeURIComponent(path)}` };
      return { state, subscribe: () => () => {} };
    },
  };
}

describe('AC-I1.1 — decorações puras da fixture de I-1', () => {
  // Cursor na linha 1 (o h1), sem foco: nenhum nó de I-1 está tocado.
  const state = previewState(fixture, { anchor: 0, focus: false });

  it('links: em linha, referência completa/colapsada/atalho com definição, autolink, e-mail, URL GFM', () => {
    for (const text of [
      '[em linha](https://exemplo.org/a?b=1#c)',
      '[referência completa][ref]',
      '[referência colapsada][]',
      '<https://exemplo.org/auto>',
      '<alguem@exemplo.org>',
      'https://exemplo.org/solta',
      'www.exemplo.org',
      '[outra nota](outra.md#titulo)',
    ])
      expect(linkMarks(decosOf(text, state)), text).toHaveLength(1);
    // Atalho `[ref]` (a primeira ocorrência solta, depois da colapsada).
    const shortcut = fixture.indexOf(', [ref], ') + 2;
    expect(linkMarks(decosIn(state, shortcut, shortcut + 5))).toHaveLength(1);
    // Sem definição: cru (nenhuma decoração).
    expect(decosOf('[solto][nada]', state)).toEqual([]);
  });

  it('tachado e código em linha (1 e 3 crases) com as classes próprias', () => {
    expect(decosOf('~~riscado~~', state).map((d) => d.class ?? d.kind)).toEqual([
      'replace',
      'cm-md-strike',
      'replace',
    ]);
    expect(decosOf('`em linha`', state).some((d) => d.class === 'cm-md-code')).toBe(true);
    const triple = decosOf('``com ` crase``', state);
    expect(triple.filter((d) => d.class === 'cm-md-code')).toHaveLength(1);
    expect(triple.filter((d) => d.kind === 'replace')).toHaveLength(2);
  });

  it('citações de nível 1–3 e a continuação preguiçosa (barra do nível mais fundo)', () => {
    const lineClass = (needle: string) =>
      decosOf(needle, state).find((d) => d.kind === 'line')?.class;
    expect(lineClass('> Citação nível 1')).toBe('cm-md-quote cm-md-quote-d1');
    expect(lineClass('> > Citação nível 2')).toBe('cm-md-quote cm-md-quote-d2');
    expect(lineClass('> > > Citação nível 3')).toBe('cm-md-quote cm-md-quote-d3');
    expect(lineClass('continuação preguiçosa')).toBe('cm-md-quote cm-md-quote-d3');
  });

  it('tarefas ` `/`x`/`X`/`-`/`/` viram caixa; feitas/canceladas com texto atenuado', () => {
    const boxes = decorate(state)
      .inline.filter((d) => d.widget instanceof TaskCheckboxWidget)
      .map((d) => (d.widget as TaskCheckboxWidget).status);
    expect(boxes).toEqual([' ', 'x', 'X', ' ', '-', '/']);
    expect(decosOf('[x] tarefa feita', state).some((d) => d.class === 'cm-md-task-done')).toBe(
      true,
    );
    expect(decosOf('[ ] tarefa a fazer', state).some((d) => d.class === 'cm-md-task-done')).toBe(
      false,
    );
  });

  it('imagem do vault vira widget com alt e título do markdown', () => {
    const image = decosOf('![Gato](img/gato.png "Um gato")', state).find(
      (d) => d.widget instanceof ImageWidget,
    );
    expect((image?.widget as ImageWidget).spec).toMatchObject({
      path: 'img/gato.png',
      alt: 'Gato',
      title: 'Um gato',
      error: null,
    });
  });

  it('função pura: sha256 do documento igual antes e depois; 0 transações despachadas', () => {
    const before = sha(state.doc.toString());
    const view = mount(fixture, [], 0);
    view.dispatch({ effects: setEditorFocus.of(false) });
    const seen: Transaction[] = [];
    const spy = vi.spyOn(view, 'dispatch').mockImplementation((...args: unknown[]) => {
      seen.push(args[0] as Transaction);
    });
    decorate(view.state);
    decorate(state);
    expect(spy).not.toHaveBeenCalled();
    expect(seen).toEqual([]);
    expect(sha(view.state.doc.toString())).toBe(before);
    expect(sha(state.doc.toString())).toBe(before);
  });
});

describe('AC-I1.2 — revelação do cru com o cursor no nó (ou na linha da citação)', () => {
  const nodes = [
    '[em linha](https://exemplo.org/a?b=1#c)',
    '~~riscado~~',
    '`em linha`',
    '![Gato](img/gato.png "Um gato")',
  ];

  it('link, tachado, código e imagem: cursor dentro → 0 decorações; fora → decorados', () => {
    for (const needle of nodes) {
      const { from, to } = at(needle);
      const outside = previewState(fixture, { anchor: 0 });
      expect(decosIn(outside, from, to).length, needle).toBeGreaterThan(0);
      for (const anchor of [from + 1, Math.floor((from + to) / 2), to - 1]) {
        const inside = previewState(fixture, { anchor });
        expect(decosIn(inside, from, to), `${needle} @${anchor}`).toEqual([]);
      }
    }
  });

  it('tarefa: cursor dentro de `[ ]` mostra o cru; na mesma linha, fora do marcador, a caixa fica', () => {
    const { from } = at('[ ] tarefa a fazer');
    const raw = previewState(fixture, { anchor: from + 1 });
    expect(decosIn(raw, from, from + 3).some((d) => d.widget instanceof TaskCheckboxWidget)).toBe(
      false,
    );
    const box = previewState(fixture, { anchor: from + 10 });
    expect(decosIn(box, from, from + 3).some((d) => d.widget instanceof TaskCheckboxWidget)).toBe(
      true,
    );
  });

  it('citação: a linha do cursor mostra as marcas `>`; as outras linhas escondem', () => {
    const line2 = at('> > Citação nível 2');
    const line1 = at('> Citação nível 1');
    const state = previewState(fixture, { anchor: line2.from + 6 });
    const cursorLine = decosIn(state, line2.from, line2.to);
    expect(cursorLine).toEqual([
      { from: line2.from, to: line2.from, kind: 'line', class: 'cm-md-quote' },
    ]);
    const other = decosIn(state, line1.from, line1.to);
    expect(other.some((d) => d.kind === 'replace' && d.from === line1.from)).toBe(true);
    // Fora da citação: as duas linhas escondem as marcas.
    const away = previewState(fixture, { anchor: 0 });
    expect(decosIn(away, line2.from, line2.to).filter((d) => d.kind === 'replace')).toHaveLength(2);
  });
});

describe('AC-I1.5 — caixa de tarefa (I-9 desligado) e "Alternar tarefa"', () => {
  it('clique na caixa de `- [ ] a` muda exatamente 1 byte; Mod-Z devolve o sha256 original', () => {
    const doc = '- [ ] a\n\nfim\n';
    const view = mount(doc);
    const box = view.contentDOM.querySelector<HTMLElement>('.cm-md-task');
    expect(box?.getAttribute('aria-checked')).toBe('false');
    box!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
    const after = view.state.doc.toString();
    expect(after).toBe('- [x] a\n\nfim\n');
    const diff = [...after].filter((c, i) => c !== doc[i]).length;
    expect(after.length).toBe(doc.length);
    expect(diff).toBe(1);
    expect(view.contentDOM.querySelector('.cm-md-task')?.getAttribute('aria-checked')).toBe('true');
    expect(undo(view)).toBe(true);
    expect(sha(view.state.doc.toString())).toBe(sha(doc));
  });

  it('"Alternar tarefa" com seleção de 3 linhas de tarefa alterna as 3 num passo de desfazer', () => {
    const doc = '- [ ] a\n- [x] b\n- [X] c\n\nfim\n';
    const view = mount(doc);
    const announces: string[] = [];
    const changes: number[] = [];
    view.dispatch({ selection: { anchor: 0, head: doc.indexOf('c') } });
    const original = view.dispatch.bind(view);
    vi.spyOn(view, 'dispatch').mockImplementation((...args: unknown[]) => {
      const spec = args[0] as { changes?: unknown[]; effects?: { value: unknown } };
      if (spec.changes) changes.push(spec.changes.length);
      if (spec.effects && typeof spec.effects.value === 'string')
        announces.push(spec.effects.value);
      original(...(args as Parameters<typeof original>));
    });
    expect(toggleTaskCommand(view)).toBe(true);
    expect(view.state.doc.toString()).toBe('- [x] a\n- [ ] b\n- [ ] c\n\nfim\n');
    expect(changes).toEqual([3]);
    expect(announces).toEqual(['3 tarefas alternadas.']);
    expect(undo(view)).toBe(true);
    expect(sha(view.state.doc.toString())).toBe(sha(doc));
    expect(undo(view)).toBe(false);
  });

  it('Mod-L é o atalho do comando (teclado)', () => {
    const doc = '- [ ] a\n\nfim\n';
    const view = mount(doc, [], 3);
    view.contentDOM.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'l', code: 'KeyL', ctrlKey: true, bubbles: true }),
    );
    expect(view.state.doc.toString()).toBe('- [x] a\n\nfim\n');
  });
});

describe('AC-I1.12 — semântica acessível (caixa, imagem, link)', () => {
  it('caixa: role=checkbox e aria-checked coerente com o estado; nome "Tarefa: <texto>"', () => {
    const doc = '- [ ] a\n- [x] b\n- [X] c\n- [-] d\n- [/] e\n\nfim\n';
    const view = mount(doc);
    const boxes = [...view.contentDOM.querySelectorAll('.cm-md-task')];
    expect(boxes.map((b) => b.getAttribute('role'))).toEqual(Array(5).fill('checkbox'));
    expect(boxes.map((b) => b.getAttribute('aria-checked'))).toEqual([
      'false',
      'true',
      'true',
      'false',
      'mixed',
    ]);
    expect(boxes.map((b) => b.getAttribute('aria-label'))).toEqual([
      'Tarefa: a',
      'Tarefa: b',
      'Tarefa: c',
      'Tarefa cancelada: d',
      'Tarefa: e',
    ]);
    // Não focável (o editor é a parada de Tab).
    expect(boxes.every((b) => !b.hasAttribute('tabindex'))).toBe(true);
  });

  it('imagem: `<img>` com o alt do markdown; link: role=link com nome que inclui o destino', () => {
    const doc = 'Veja ![Um gato](gato.png) e [site](https://exemplo.org/a?b=1#c).\n\nfim\n';
    const view = mount(doc, [imageSourceFacet.of(fakeImages()), noteContext.of({ path: 'n.md' })]);
    const img = view.contentDOM.querySelector('img:not(.cm-widgetBuffer)');
    expect(img?.getAttribute('alt')).toBe('Um gato');
    const link = view.contentDOM.querySelector('.cm-md-link');
    expect(link?.getAttribute('role')).toBe('link');
    expect(link?.getAttribute('aria-label')).toBe('site (link: https://exemplo.org/a?b=1#c)');
    expect(view.contentDOM.querySelector('a[href]')).toBeNull();
  });
});

describe('AC-I1.6 / AC-I1.7 / AC-I1.10 — widget de imagem (cache falsa)', () => {
  it('as formas de caminho resolvem dentro do vault e mostram `<img src="blob:…">` com o alt', () => {
    const doc = [
      '![png](a.png) ![jpg](/raiz/b.jpg) ![gif](../c.gif) ![webp](<com espaços.webp>)',
      '![svg](com%20espa%C3%A7os.svg) ![PNG maiúsculo](D.PNG)',
      '',
      'fim',
    ].join('\n');
    const images = fakeImages();
    const view = mount(doc, [imageSourceFacet.of(images), noteContext.of({ path: 'notas/n.md' })]);
    expect(images.requests).toEqual([
      'notas/a.png',
      'raiz/b.jpg',
      'c.gif',
      'notas/com espaços.webp',
      'notas/com espaços.svg',
      'notas/D.PNG',
    ]);
    const imgs = [...view.contentDOM.querySelectorAll('img:not(.cm-widgetBuffer)')];
    expect(imgs.map((i) => i.getAttribute('alt'))).toEqual([
      'png',
      'jpg',
      'gif',
      'webp',
      'svg',
      'PNG maiúsculo',
    ]);
    expect(imgs.every((i) => i.getAttribute('src')?.startsWith('blob:'))).toBe(true);
  });

  it('https:, data: e file: ficam texto: 0 pedidos ao serviço, nenhum `<img>`', () => {
    const doc =
      '![r](https://exemplo.org/x.png) ![d](data:image/png;base64,iVBORw0KGgo=) ![f](file:///tmp/x.png)\n\nfim\n';
    const images = fakeImages();
    const view = mount(doc, [imageSourceFacet.of(images), noteContext.of({ path: 'n.md' })]);
    expect(images.requests).toEqual([]);
    expect(view.contentDOM.querySelector('img:not(.cm-widgetBuffer)')).toBeNull();
    expect(view.contentDOM.querySelector('[data-testid="cm-image"]')).toBeNull();
    expect(view.contentDOM.textContent).toContain('https://exemplo.org/x.png');
  });

  it('SVG só por `<img>`: nada do conteúdo entra no DOM, nenhuma bandeira muda em window', () => {
    const doc = '![hostil](hostil.svg)\n\nfim\n';
    const view = mount(doc, [imageSourceFacet.of(fakeImages()), noteContext.of({ path: 'n.md' })]);
    const figure = view.contentDOM.querySelector('[data-testid="cm-image"]');
    expect(figure?.getAttribute('data-state')).toBe('ok');
    expect(figure?.querySelectorAll('*').length).toBe(1);
    expect(figure?.firstElementChild?.tagName).toBe('IMG');
    expect(view.contentDOM.querySelector('script, foreignObject, image')).toBeNull();
    expect(Object.keys(window).filter((k) => k.startsWith('__svg'))).toEqual([]);
  });
});
