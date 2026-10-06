import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { LocalFsProvider } from '@simplemd/vault';
import type { AppPlatform } from '../types';
import { TauriFsPort } from './fsPort';

/** Plataforma de produção (Tauri 2). Só este diretório importa `@tauri-apps/*` (lint). */
export function createTauriPlatform(): AppPlatform {
  const window = getCurrentWindow();
  return {
    vault: new LocalFsProvider(new TauriFsPort()),
    onCloseRequested(handler) {
      // O Tauri espera o handler e, se não houver preventDefault, destrói a janela.
      const unlisten = window.onCloseRequested(async (event) => {
        if (!(await handler())) event.preventDefault();
      });
      return () => void unlisten.then((stop) => stop());
    },
    closeWindow: () => window.destroy(),
    log(event) {
      void invoke('app_mark', { marker: event === 'simplemd:ready' ? 'ready' : 'conflict-shown' });
    },
  };
}
