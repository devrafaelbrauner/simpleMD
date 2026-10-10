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
 */
export function createImageService(deps: ImageServiceDeps): ImageBlobCache {
  const { platform, store } = deps;
  const clock = deps.clock ?? systemClock;
  const cache = new ImageBlobCache({
    read: (path) => {
      const handle = store.getState().handle;
      if (!handle)
        return Promise.reject(new VaultError('NOT_FOUND', 'Nenhuma pasta aberta.', { path }));
      return platform.vault.readImage(handle, path);
    },
  });

  let unwatch: (() => void) | null = null;
  let poll: unknown = null;

  const stopPolling = () => {
    if (poll !== null) clock.clearTimeout(poll);
    poll = null;
  };

  /** Sem observador: confere o `mtime` das imagens com entrada; mudou ou sumiu → recarrega. */
  const startPolling = (handle: VaultHandle) => {
    if (poll !== null) return;
    const tick = () => {
      poll = clock.setTimeout(() => {
        void Promise.all(
          cache.entries().map(async ({ path, mtime }) => {
            const stat = await platform.vault.stat(handle, path).catch(() => null);
            if (store.getState().handle !== handle) return;
            if (!stat || stat.mtime !== mtime) cache.invalidate(path);
          }),
        ).finally(() => {
          if (poll !== null && store.getState().handle === handle) tick();
        });
      }, POLL_INTERVAL_MS);
    };
    tick();
  };

  const watch = (handle: VaultHandle | null) => {
    unwatch?.();
    unwatch = null;
    stopPolling();
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
