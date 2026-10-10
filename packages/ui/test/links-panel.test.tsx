import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  LINKS_TEXT,
  LinksPanel,
  linksGroupLabel,
  linksSummary,
  SidePanel,
  type LinksGroup,
  type LinksPanelProps,
} from '../src';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const BOLO: LinksGroup[] = [
  {
    path: 'diario/2026-10-01.md',
    title: '1º de outubro',
    occurrences: [{ line: 6, context: 'Fiz o [[Bolo]] para o café.', matchFrom: 6, matchTo: 14 }],
  },
  {
    path: 'wikilinks.md',
    title: 'Wikilinks',
    occurrences: [
      { line: 2, context: 'Única: [[Bolo]].', matchFrom: 7, matchTo: 15 },
      { line: 3, context: 'Com título: [[Bolo#Cobertura]].', matchFrom: 12, matchTo: 30 },
      { line: 10, context: null, matchFrom: 0, matchTo: 0 },
    ],
  },
];

function panel(props: Partial<LinksPanelProps> = {}) {
  const onOpen = vi.fn<LinksPanelProps['onOpen']>();
  const onRetry = vi.fn();
  const view = render(
    <LinksPanel status="ready" groups={BOLO} onOpen={onOpen} onRetry={onRetry} {...props} />,
  );
  return { onOpen, onRetry, ...view };
}

/** Espera um quadro de pintura (o painel marca `simplemd:links-shown` num `requestAnimationFrame`). */
function nextFrame(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  requestAnimationFrame(() => resolve());
  return promise;
}

const listbox = () => screen.getByRole('listbox', { name: LINKS_TEXT.listbox });
const activeText = () =>
  document.getElementById(listbox().getAttribute('aria-activedescendant') ?? '')?.textContent;

describe('painel Links — estados (STR-151…STR-153; DESIGN §R7.6.5)', () => {
  test('sem nota: texto STR, sem subtítulo nem listbox', () => {
    panel({ status: 'no-tab', groups: [] });
    expect(screen.getByTestId('links-panel').getAttribute('data-state')).toBe('no-tab');
    expect(screen.getByText(LINKS_TEXT.noTab)).toBeTruthy();
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(screen.queryByText(LINKS_TEXT.subtitle)).toBeNull();
  });

  test('indexando: "Indexando…" sem anúncio (aria-live off) e sem listbox', () => {
    panel({ status: 'indexing', groups: [] });
    const indexing = screen.getByTestId('links-indexing');
    expect(indexing.textContent).toBe('Indexando…');
    expect(indexing.getAttribute('aria-live')).toBe('off');
    expect(screen.getByText(LINKS_TEXT.subtitle)).toBeTruthy();
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  test('vazio: "Nenhuma nota aponta para esta."', () => {
    panel({ status: 'empty', groups: [] });
    expect(screen.getByTestId('links-empty').textContent).toBe('Nenhuma nota aponta para esta.');
    expect(screen.queryByTestId('links-summary')).toBeNull();
  });

  test('erro de listagem: alerta + "Tentar novamente" chama onRetry', () => {
    const { onRetry } = panel({ status: 'error', groups: [] });
    expect(screen.getByRole('alert').textContent).toBe(LINKS_TEXT.error);
    fireEvent.click(screen.getByRole('button', { name: LINKS_TEXT.retry }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  test('lista: resumo, grupos nomeados (STR-153) e opções só de texto', () => {
    panel();
    expect(screen.getByTestId('links-summary').textContent).toBe(
      '2 notas apontam para esta · 4 links',
    );
    const groups = within(listbox()).getAllByRole('group');
    expect(groups.map((g) => g.getAttribute('data-path'))).toEqual([
      'diario/2026-10-01.md',
      'wikilinks.md',
    ]);
    expect(
      within(listbox()).getByRole('group', { name: 'Wikilinks — wikilinks.md, 3 ocorrências' }),
    ).toBe(groups[1]);
    const options = within(listbox()).getAllByRole('option');
    expect(options).toHaveLength(4);
    // Nome = conteúdo (WCAG 2.5.3): sem aria-label; contexto · linha n.
    expect(options.every((o) => !o.hasAttribute('aria-label'))).toBe(true);
    expect(options[0]?.textContent).toBe('Fiz o [[Bolo]] para o café. · linha 7');
    expect(options[0]?.querySelector('.smd-links-match')?.textContent).toBe('[[Bolo]]');
    // Contexto ainda não lido: reticências, linha presente.
    expect(options[3]?.textContent).toBe('… · linha 11');
    // Uma parada de Tab: só o listbox é focável.
    expect(listbox().tabIndex).toBe(0);
    expect(options.every((o) => !o.hasAttribute('tabindex'))).toBe(true);
    expect(screen.queryByTestId('links-limit')).toBeNull();
  });

  test('aviso de limite (LNK-LIMIT) quando a nota passou de 1.000 links', () => {
    panel({ overLimit: true });
    expect(screen.getByTestId('links-limit').textContent).toBe(LINKS_TEXT.limit);
  });

  test('marca simplemd:links-shown uma vez quando a lista pinta (NFR-46)', async () => {
    const mark = vi.spyOn(performance, 'mark');
    const onShown = vi.fn();
    const { rerender, onOpen, onRetry } = panel({ onShown });
    await act(nextFrame);
    expect(onShown).toHaveBeenCalledTimes(1);
    expect(mark).toHaveBeenCalledWith('simplemd:links-shown');
    rerender(
      <LinksPanel
        status="ready"
        groups={BOLO.slice(1)}
        onOpen={onOpen}
        onRetry={onRetry}
        onShown={onShown}
      />,
    );
    await act(nextFrame);
    expect(onShown).toHaveBeenCalledTimes(1);
  });

  test('textos do resumo e do grupo: singular, plural e milhar pt-BR', () => {
    expect(linksSummary(1, 1)).toBe('1 nota aponta para esta · 1 link');
    expect(linksSummary(1200, 3400)).toBe('1.200 notas apontam para esta · 3.400 links');
    expect(
      linksGroupLabel({ path: 'a.md', title: 'A', occurrences: [BOLO[0]!.occurrences[0]!] }),
    ).toBe('A — a.md, 1 ocorrência');
  });
});

describe('painel Links — teclado (AC-I2.10; UX-R7-D18)', () => {
  test('↑/↓/Home/End/PageUp/PageDown cruzam grupos; Enter abre a origem na linha', () => {
    const { onOpen } = panel();
    const list = listbox();
    list.focus();
    expect(activeText()).toContain('Fiz o');
    fireEvent.keyDown(list, { key: 'ArrowDown' });
    expect(activeText()).toContain('Única');
    fireEvent.keyDown(list, { key: 'End' });
    expect(activeText()).toContain('linha 11');
    fireEvent.keyDown(list, { key: 'ArrowDown' });
    expect(activeText()).toContain('linha 11');
    fireEvent.keyDown(list, { key: 'Home' });
    expect(activeText()).toContain('Fiz o');
    fireEvent.keyDown(list, { key: 'ArrowUp' });
    expect(activeText()).toContain('Fiz o');
    fireEvent.keyDown(list, { key: 'PageDown' });
    expect(activeText()).toContain('linha 11');
    fireEvent.keyDown(list, { key: 'PageUp' });
    expect(activeText()).toContain('Fiz o');
    fireEvent.keyDown(list, { key: 'ArrowDown' });
    fireEvent.keyDown(list, { key: 'ArrowDown' });
    fireEvent.keyDown(list, { key: 'Enter' });
    expect(onOpen).toHaveBeenCalledWith('wikilinks.md', 3);
    // Com modificador, o painel não consome a tecla (atalhos do app).
    fireEvent.keyDown(list, { key: 'ArrowDown', metaKey: true });
    expect(activeText()).toContain('Com título');
    expect(document.activeElement).toBe(list);
    const selected = within(list)
      .getAllByRole('option')
      .filter((o) => o.getAttribute('aria-selected') === 'true');
    expect(selected).toHaveLength(1);
  });

  test('clique numa ocorrência abre a origem e não tira o foco antes (mousedown)', () => {
    const { onOpen } = panel();
    const option = within(listbox()).getAllByRole('option')[0]!;
    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    option.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    fireEvent.click(option);
    expect(onOpen).toHaveBeenCalledWith('diario/2026-10-01.md', 6);
  });

  test('atualização não rouba o foco; a opção ativa some → a vizinha assume', () => {
    const { rerender, onOpen, onRetry } = panel();
    const list = listbox();
    list.focus();
    fireEvent.keyDown(list, { key: 'End' });
    expect(activeText()).toContain('linha 11');
    const fewer: LinksGroup[] = [
      BOLO[0]!,
      { ...BOLO[1]!, occurrences: BOLO[1]!.occurrences.slice(0, 2) },
    ];
    rerender(<LinksPanel status="ready" groups={fewer} onOpen={onOpen} onRetry={onRetry} />);
    expect(document.activeElement).toBe(listbox());
    expect(activeText()).toContain('Com título');
    // Nada mudou de lugar: a mesma opção continua ativa.
    rerender(<LinksPanel status="ready" groups={[...fewer]} onOpen={onOpen} onRetry={onRetry} />);
    expect(activeText()).toContain('Com título');
  });
});

describe('CR-S2-05 — o listbox focado some: o foco vai ao painel, não ao body', () => {
  test.each([
    ['última ocorrência removida (vazio)', 'empty'],
    ['"Indexando…"', 'indexing'],
  ] as const)('%s', (_label, status) => {
    const { rerender, onOpen, onRetry } = panel();
    listbox().focus();
    expect(document.activeElement).toBe(listbox());
    rerender(<LinksPanel status={status} groups={[]} onOpen={onOpen} onRetry={onRetry} />);
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(document.activeElement).toBe(screen.getByTestId('links-panel'));
    expect(screen.getByTestId('links-panel').tabIndex).toBe(-1);
  });

  test('sem foco no listbox, a atualização não puxa o foco', () => {
    const { rerender, onOpen, onRetry } = panel();
    const outside = document.body.appendChild(document.createElement('button'));
    outside.focus();
    rerender(<LinksPanel status="empty" groups={[]} onOpen={onOpen} onRetry={onRetry} />);
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });
});

describe('abas do painel lateral com quebra (AC-I2.9; D-47, EC3-V-1)', () => {
  const css = readFileSync(resolve(import.meta.dirname, '../src/styles/components.css'), 'utf8');
  const rule = (selector: string) => {
    const at = css.indexOf(`${selector} {`);
    return at < 0 ? '' : css.slice(at, css.indexOf('}', at));
  };

  test('a faixa quebra a linha e não rola na horizontal (CSS)', () => {
    const tabs = rule('.smd-sidepanel-tabs');
    expect(tabs).toContain('flex-wrap: wrap');
    expect(tabs).toContain('overflow: visible');
    expect(tabs).toContain('height: auto');
    expect(tabs).not.toMatch(/overflow-x:\s*(auto|scroll)/);
  });

  test('as 5 abas do app na ordem do DOM; ativar uma nunca reordena; ←/→/Home/End seguem o DOM', () => {
    const onActivate = vi.fn();
    const panels = ['Catálogo', 'Sumário', 'Propriedades', 'Links', 'Chat IA'].map((title, i) => ({
      kind: 'builtin' as const,
      id: ['catalog', 'toc', 'properties', 'links', 'chat'][i]!,
      title,
      content: <p>{title}</p>,
    }));
    const { rerender } = render(
      <SidePanel open activeId="catalog" onActivate={onActivate} panels={panels} />,
    );
    const tablist = screen.getByRole('tablist', { name: 'Painéis' });
    expect(tablist.className).toContain('smd-sidepanel-tabs');
    const titles = () =>
      within(tablist)
        .getAllByRole('tab')
        .map((t) => t.textContent);
    expect(titles()).toEqual(['Catálogo', 'Sumário', 'Propriedades', 'Links', 'Chat IA']);
    rerender(<SidePanel open activeId="links" onActivate={onActivate} panels={panels} />);
    expect(titles()).toEqual(['Catálogo', 'Sumário', 'Propriedades', 'Links', 'Chat IA']);
    const links = within(tablist).getByRole('tab', { name: 'Links' });
    expect(links.getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('region', { name: 'Links' }).textContent).toBe('Links');
    fireEvent.keyDown(links, { key: 'ArrowRight' });
    expect(onActivate).toHaveBeenLastCalledWith('chat');
    fireEvent.keyDown(links, { key: 'ArrowLeft' });
    expect(onActivate).toHaveBeenLastCalledWith('properties');
    fireEvent.keyDown(links, { key: 'End' });
    expect(onActivate).toHaveBeenLastCalledWith('chat');
    fireEvent.keyDown(links, { key: 'Home' });
    expect(onActivate).toHaveBeenLastCalledWith('catalog');
  });
});
