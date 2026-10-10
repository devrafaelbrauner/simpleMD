import { ImageBlobCache } from '@simplemd/core';
import { VaultError, type VaultHandle } from '@simplemd/vault';
import type { AppPlatform } from '../platform/types';
import type { AppStore } from '../state/store';
import { POLL_INTERVAL_MS, systemClock, type Clock } from '../state/sync';

export interface ImageServiceDeps {
  readonly platform: AppPlatform;
  readonly store: AppStore;
  readonly clock?: Clock;
}

/**
 * Cache de imagens da janela (R-I1.7; arch-frontend r7 §5.4; D-R7-S1-02): lê pelo provider da pasta
 * aberta (tipo, bytes mágicos e teto no gateway; links e `.git/` recusados sem leitura) e liga a
 * cache aos eventos do app — trocar de pasta revoga tudo (0 blobs vivos da anterior), fechar uma
 * aba libera as imagens dela, e a mudança externa de um arquivo de imagem recarrega em ≤ 2 s pelo
 * observador próprio do provider (ou, sem observador, pela sondagem do `mtime` a cada 1 s).
 *
 * A sondagem só fica armada enquanto a cache tem entradas: sem imagens, nenhum temporizador (não
 * disputa o relógio com a sondagem das notas nem com os testes de relógio falso).
 */
export function createImageService(deps: ImageServiceDeps): ImageBlobCache {
  const { platform, store } = deps;
  const clock = deps.clock ?? systemClock;
  /** Pasta em modo de sondagem (sem observador ou observador indisponível); `null` = observador. */
  let polled: VaultHandle | null = null;
  let poll: unknown = null;

  const cache = new ImageBlobCache({
    read: (path) => {
      const handle = store.getState().handle;
      if (!handle)
        return Promise.reject(new VaultError('NOT_FOUND', 'Nenhuma pasta aberta.', { path }));
      if (polled === handle) arm(handle);
      return platform.vault.readImage(handle, path);
    },
  });

  const stopPolling = () => {
    if (poll !== null) clock.clearTimeout(poll);
    poll = null;
  };

  /**
   * `mtime` visto pela sondagem nas imagens recusadas (`null` = ausente): uma recusa só é relida
   * quando o arquivo aparece, muda ou some — nunca a cada ciclo (CR-S1-02: uma imagem grande demais
   * seria lida de novo a cada 1 s).
   */
  const refused = new Map<string, number | null>();

  /** Confere o `mtime` das imagens com entrada; mudou ou sumiu → recarrega. Cache vazia → desarma. */
  function arm(handle: VaultHandle) {
    if (poll !== null) return;
    poll = clock.setTimeout(() => {
      void Promise.all(
        cache.entries().map(async ({ path, mtime, state }) => {
          if (state.kind === 'loading') return;
          const stat = await platform.vault.stat(handle, path).catch(() => null);
          if (store.getState().handle !== handle) return;
          const now = stat ? stat.mtime : null;
          if (state.kind === 'ok') {
            refused.delete(path);
            if (now !== mtime) cache.invalidate(path);
            return;
          }
          // Primeira sondagem de uma recusa: "não encontrada" esperava ausência; as outras, o
          // arquivo como está agora.
          const last = refused.has(path)
            ? refused.get(path)
            : state.error === 'not-found'
              ? null
              : now;
          refused.set(path, now);
          if (now !== last) cache.invalidate(path);
        }),
      ).finally(() => {
        if (polled !== handle) return;
        poll = null;
        if (cache.entries().length > 0) arm(handle);
      });
    }, POLL_INTERVAL_MS);
  }

  const startPolling = (handle: VaultHandle) => {
    polled = handle;
    if (cache.entries().length > 0) arm(handle);
  };

  let unwatch: (() => void) | null = null;
  const watch = (handle: VaultHandle | null) => {
    unwatch?.();
    unwatch = null;
    polled = null;
    stopPolling();
    refused.clear();
    cache.reset();
    if (!handle) return;
    if (!platform.vault.watch) {
      startPolling(handle);
      return;
    }
    unwatch = platform.vault.watch(handle, (event) => {
      if (store.getState().handle !== handle) return;
      if (event.kind === 'unavailable') startPolling(handle);
      else for (const path of event.paths) cache.invalidate(path);
    });
  };

  let { handle, tabs } = store.getState();
  if (handle) watch(handle);
  store.subscribe((state) => {
    if (state.handle !== handle) {
      handle = state.handle;
      watch(handle);
    }
    if (state.tabs !== tabs) {
      const open = new Set(state.tabs.map((tab) => tab.path));
      for (const tab of tabs) if (!open.has(tab.path)) cache.releaseOwner(tab.path);
      tabs = state.tabs;
    }
  });
  return cache;
}
