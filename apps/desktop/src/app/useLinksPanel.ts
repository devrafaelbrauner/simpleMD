import type { EditorView } from '@codemirror/view';
import { noteContext, type BacklinkGroup } from '@simplemd/core';
import type { LinksGroup, LinksPanelProps } from '@simplemd/ui';
import type { CatalogSnapshot } from '@simplemd/vault';
import { useEffect, useMemo, useState } from 'react';
import type { AppController } from './controller';

/** Notas de origem lidas por vista para o contexto (D-R7-B09). */
export const LINKS_CONTEXT_SOURCES = 50;
/** Contexto mostrado por ocorrência (R-I2.7). */
export const LINKS_CONTEXT_MAX = 200;
/** Linhas de notas de origem guardadas na sessão (LRU por nota). */
const CONTEXT_CACHE_NOTES = 200;
/** Quadros de espera até o editor mostrar a nota aberta. */
const SHOW_FRAMES = 30;

/**
 * Recorte de ≤ 200 caracteres da linha em volta do link (o trecho do link sempre dentro), com
 * as posições do trecho no recorte.
 */
export function contextWindow(
  line: string,
  column: number,
  length: number,
): { context: string; matchFrom: number; matchTo: number } {
  const end = Math.min(line.length, column + length);
  if (line.length <= LINKS_CONTEXT_MAX) return { context: line, matchFrom: column, matchTo: end };
  const room = Math.max(0, LINKS_CONTEXT_MAX - (end - column));
  let from = Math.max(0, column - Math.floor(room / 2));
  const to = Math.min(line.length, from + LINKS_CONTEXT_MAX);
  from = Math.max(0, to - LINKS_CONTEXT_MAX);
  const matchTo = Math.min(end, to) - from;
  return { context: line.slice(from, to), matchFrom: column - from, matchTo };
}

/**
 * Linhas das notas de origem (texto da aba aberta e sem edição, senão o disco), por caminho +
 * mtime, da pasta aberta (trocar de pasta esvazia; CR-S2-07).
 */
class SourceLines {
  readonly #cache = new Map<string, { mtime: number; lines: readonly string[] }>();
  #vault: unknown = null;

  /** A pasta aberta mudou: as linhas guardadas eram de outra pasta. */
  forVault(handle: unknown): void {
    if (handle === this.#vault) return;
    this.#vault = handle;
    this.#cache.clear();
  }

  get(path: string, mtime: number): readonly string[] | undefined {
    const hit = this.#cache.get(path);
    if (!hit || hit.mtime !== mtime) return undefined;
    this.#cache.delete(path);
    this.#cache.set(path, hit);
    return hit.lines;
  }

  set(path: string, mtime: number, text: string): void {
    this.#cache.delete(path);
    this.#cache.set(path, {
      mtime,
      lines: text
        .replace(/^\uFEFF/, '')
        .replace(/\r\n?/g, '\n')
        .split('\n'),
    });
    for (const key of this.#cache.keys()) {
      if (this.#cache.size <= CONTEXT_CACHE_NOTES) break;
      this.#cache.delete(key);
    }
  }
}

const sourceLines = new WeakMap<AppController, SourceLines>();

/**
 * Painel "Links" do app (R-I2.7; arch-frontend r7 §6): backlinks da nota ativa pelo índice
 * (`catalog.links`), estados (sem nota / indexando / vazio / lista / erro de listagem, D-R7-S2-03b)
 * e o contexto de cada ocorrência lido só das notas de origem (≤ 50 por vista), sem roubar foco.
 */
export function useLinksPanel(
  app: AppController,
  catalog: CatalogSnapshot,
  activePath: string | null,
  visible: boolean,
  editorView: () => EditorView | null,
): LinksPanelProps {
  const links = app.catalog.links;
  let lines = sourceLines.get(app);
  if (!lines) sourceLines.set(app, (lines = new SourceLines()));
  const cache = lines;
  cache.forVault(app.store.getState().handle);
  const [linksVersion, setLinksVersion] = useState(links.version);
  useEffect(() => links.subscribe(() => setLinksVersion(links.version)), [links]);
  const [loaded, setLoaded] = useState(0);

  const backlinks = useMemo(
    () => (activePath === null || !visible ? null : links.backlinks(activePath)),
    // `catalog.version`/`linksVersion`: o índice publicou ou o conjunto de notas mudou.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [links, activePath, visible, catalog.version, linksVersion],
  );
  const mtimes = useMemo(() => {
    const map = new Map<string, number>();
    for (const entry of catalog.entries) map.set(entry.path, entry.mtime);
    return map;
  }, [catalog.entries]);

  // Contexto preguiçoso: lê as origens que ainda não estão no cache (até 50 por vista).
  useEffect(() => {
    if (!backlinks) return;
    const handle = app.store.getState().handle;
    if (!handle) return;
    let cancelled = false;
    const pending = backlinks.groups
      .slice(0, LINKS_CONTEXT_SOURCES)
      .filter((group) => cache.get(group.path, mtimes.get(group.path) ?? -1) === undefined);
    if (pending.length === 0) return;
    void Promise.all(
      pending.map(async (group) => {
        const mtime = mtimes.get(group.path) ?? -1;
        // Posições vêm do índice (versão salva): o buffer só serve se não tem edição (CR-S2-07).
        const open = app.registry.get(group.path);
        if (open && app.store.getState().docs[group.path] === 'clean') {
          cache.set(group.path, mtime, open.state.doc.toString());
          return;
        }
        try {
          const { text } = await app.platform.vault.read(handle, group.path);
          cache.set(group.path, mtime, text);
        } catch {
          // Origem ilegível: a ocorrência fica só com "linha n" (D-R7-S2-03b).
          cache.set(group.path, mtime, '');
        }
      }),
    ).then(() => {
      if (!cancelled) setLoaded((n) => n + 1);
    });
    return () => {
      cancelled = true;
    };
  }, [app, backlinks, cache, mtimes]);

  const groups = useMemo<LinksGroup[]>(() => {
    if (!backlinks) return [];
    return backlinks.groups.map((group: BacklinkGroup) => {
      const text = cache.get(group.path, mtimes.get(group.path) ?? -1);
      return {
        path: group.path,
        title: group.title,
        occurrences: group.occurrences.map((occurrence) => {
          const line = text?.[occurrence.line];
          if (line === undefined || line === '')
            return { line: occurrence.line, context: null, matchFrom: 0, matchTo: 0 };
          return {
            line: occurrence.line,
            ...contextWindow(line, occurrence.column, occurrence.length),
          };
        }),
      };
    });
    // `loaded`: o cache de linhas ganhou notas.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backlinks, cache, mtimes, loaded]);

  const status: LinksPanelProps['status'] =
    activePath === null
      ? 'no-tab'
      : catalog.listFailed
        ? 'error'
        : catalog.status !== 'ready'
          ? 'indexing'
          : groups.length === 0
            ? 'empty'
            : 'ready';

  return {
    status,
    groups,
    overLimit: activePath !== null && links.overLimit(activePath),
    onOpen: (path, line) => {
      void app.sync.openFile(path).then((opened) => {
        if (!opened) return;
        const show = (frames: number) => {
          const view = editorView();
          if (!view || view.state.facet(noteContext).path !== path) {
            if (frames > 0) requestAnimationFrame(() => show(frames - 1));
            return;
          }
          const target = view.state.doc.line(Math.min(line + 1, view.state.doc.lines));
          view.dispatch({ selection: { anchor: target.from }, scrollIntoView: true });
          view.focus();
        };
        show(SHOW_FRAMES);
      });
    },
    onRetry: () => app.catalog.revalidate(),
  };
}
