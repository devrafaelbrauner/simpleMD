import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { open, save } from '@tauri-apps/plugin-dialog';
import { readFile, stat, writeFile } from '@tauri-apps/plugin-fs';
import { VAULT_READ_LIMITS } from '@simplemd/themes';
import { LocalFsProvider } from '@simplemd/vault';
import type { AppPlatform } from '../types';
import { TauriFsPort } from './fsPort';

const THEME_FILTERS = [{ name: 'Tema do simpleMD', extensions: ['json'] }];

/**
 * Plataforma de produção (Tauri 2). Só este diretório importa `@tauri-apps/*` (lint). Os diálogos
 * de salvar/abrir do plugin concedem ao plugin fs SÓ o arquivo escolhido, durante a sessão
 * (arch-backend §1.4.2, C-10); não há escopo estático.
 */
export function createTauriPlatform(): AppPlatform {
  const window = getCurrentWindow();
  return {
    vault: new LocalFsProvider(new TauriFsPort(), { readLimits: VAULT_READ_LIMITS }),
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
    async saveFile(suggestedName, bytes) {
      // O diálogo do sistema já confirmou a substituição, se o arquivo existia.
      const path = await save({
        title: 'Exportar tema',
        defaultPath: suggestedName,
        filters: THEME_FILTERS,
      });
      if (path === null) return null;
      await writeFile(path, bytes);
      return path;
    },
    async pickFile() {
      const path = await open({
        title: 'Importar tema',
        multiple: false,
        directory: false,
        filters: THEME_FILTERS,
      });
      if (path === null) return null;
      // O tamanho vem do `stat`, ANTES de ler (teto de 256 KB; NFR-15).
      const { size } = await stat(path);
      return { name: path.split(/[\\/]/).pop() ?? path, size, read: () => readFile(path) };
    },
  };
}
