import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import type { DictionaryLayer } from '@simplemd/plugin-api/internal/host';
import { THEME_MAX_BYTES, VAULT_READ_LIMITS } from '@simplemd/themes';
import { LocalFsProvider, VaultError } from '@simplemd/vault';
import type {
  AppLogEvent,
  AppPlatform,
  DictionaryImported,
  GlobalDictionaryLayer,
  PickedFile,
  SaveTarget,
  SaveTargetPort,
} from '../types';
import { createTauriAi } from './aiTransport';
import { TauriFsPort } from './fsPort';
import { createTauriLanguageTool } from './languageTool';

/** Evento de log → marcador fechado do Rust (`app_mark`). */
const MARKERS: Record<AppLogEvent, string> = {
  'simplemd:ready': 'ready',
  'simplemd:conflict-shown': 'conflict-shown',
  'simplemd:plugin-active': 'plugin-active',
  'simplemd:catalog-shown': 'catalog-shown',
  'ai:first-paint': 'ai-first-paint',
  'simplemd:export-print': 'export-print',
};

/** Detalhe de `TOO_LARGE` em `open_file_pick`: o Rust conta o tamanho e não lê nada. */
function tooLargePick(error: unknown): { fileName: string; size: number } | null {
  if (typeof error !== 'object' || error === null || !('code' in error) || !('detail' in error))
    return null;
  const { code, detail } = error;
  if (code !== 'TOO_LARGE' || typeof detail !== 'object' || detail === null) return null;
  if (!('fileName' in detail) || typeof detail.fileName !== 'string') return null;
  const size = 'size' in detail ? Number(detail.size) : Number.NaN;
  return { fileName: detail.fileName, size: Number.isFinite(size) ? size : Infinity };
}

/**
 * Plataforma de produção (Tauri 2). Só este diretório importa `@tauri-apps/*` (lint). Sem plugin
 * fs nem permissões de diálogo no webview (arch-backend r2 §1.2): os diálogos de salvar/abrir são
 * comandos Rust; salvar devolve um token de uso único para o arquivo escolhido, e o webview nunca
 * vê nem envia o caminho absoluto.
 */
export function createTauriPlatform(): AppPlatform {
  const window = getCurrentWindow();
  const port = new TauriFsPort();
  /** Comandos de aprovação: o Rust usa a raiz ATIVA (pelo token); o webview nunca envia uma raiz. */
  const approval = async <T>(command: string, args: Record<string, unknown> = {}): Promise<T> => {
    const token = port.token;
    if (token === null) throw new VaultError('PERMISSION_DENIED', 'Nenhuma pasta aberta.');
    return invoke<T>(command, { token, ...args });
  };
  /**
   * Token da camada de dicionário (r33a): a da pasta vai com o da pasta aberta (sem pasta →
   * `NO_VAULT`, sem IPC nem diálogo); a global não usa token. O Rust confere de novo.
   */
  const layerToken = (layer: DictionaryLayer): number | null => {
    if (layer === 'global') return null;
    const token = port.token;
    if (token === null) throw { code: 'NO_VAULT', message: 'Nenhuma pasta aberta.' };
    return token;
  };
  const saveTarget: SaveTargetPort = {
    // `sourceRel` igual ao destino escolhido → o Rust rejeita com SAME_AS_SOURCE antes de gravar.
    pick: (opts) => invoke<SaveTarget | null>('save_target_pick', { ...opts }),
    write: (token, bytes) =>
      invoke('save_target_write', bytes, { headers: { 'x-simplemd-save-token': token } }),
  };
  return {
    vault: new LocalFsProvider(port, { readLimits: VAULT_READ_LIMITS }),
    onCloseRequested(handler) {
      // O Tauri espera o handler e, se não houver preventDefault, destrói a janela.
      const unlisten = window.onCloseRequested(async (event) => {
        if (!(await handler())) event.preventDefault();
      });
      return () => void unlisten.then((stop) => stop());
    },
    closeWindow: () => window.destroy(),
    log(event) {
      void invoke('app_mark', { marker: MARKERS[event] });
    },
    ai: createTauriAi(),
    // r7 R-X7.6: o Rust valida e abre (função livre do opener; nenhum plugin registrado).
    openUrl: (url) => invoke<void>('open_url', { url }),
    languageTool: createTauriLanguageTool(),
    // r32a: camada global de dicionários; o Rust guarda a pasta e recebe só o nome do arquivo.
    // r33a: importar (diálogo nativo do Rust), renomear e remover listas nas duas camadas.
    dictionaries: {
      readGlobal: () => invoke<GlobalDictionaryLayer>('dict_global_read'),
      writeGlobal: (name, text, expectedSha256) =>
        invoke<void>('dict_global_write', { name, text, expectedSha256 }),
      import: async (layer) =>
        invoke<DictionaryImported | null>('dict_import', { layer, token: layerToken(layer) }),
      rename: async (layer, name, to) =>
        invoke<void>('dict_manage', {
          layer,
          token: layerToken(layer),
          name,
          action: { rename: { to } },
        }),
      remove: async (layer, name) =>
        invoke<void>('dict_manage', { layer, token: layerToken(layer), name, action: 'remove' }),
    },
    approvals: {
      get: () => approval('plugin_approvals_get'),
      set: (id, sha256) => approval('plugin_approval_set', { id, sha256 }),
      setEnabled: (id, enabled) => approval('plugin_enabled_set', { id, enabled }),
      clear: (id) => approval('plugin_approval_clear', { id }),
    },
    saveTarget,
    async saveFile(suggestedName, bytes) {
      // O diálogo do sistema já confirmou a substituição, se o arquivo existia.
      const picked = await saveTarget.pick({ suggestedName, ext: 'json' });
      if (picked === null) return null;
      await saveTarget.write(picked.token, bytes);
      return picked.fileName;
    },
    async print() {
      // macOS: o Tauri troca `window.print` por `invoke('plugin:webview|print')` (precisa de
      // `core:webview:allow-print`; sem ela a promessa rejeita). Windows: impressão do WebView2.
      // (`window` aqui é a janela do Tauri; a impressão é a do documento.)
      const pending: unknown = globalThis.print();
      await pending;
    },
    async pickFile(): Promise<PickedFile | null> {
      try {
        const picked = await invoke<{ fileName: string; bytes: number[] } | null>(
          'open_file_pick',
          { ext: 'json', maxBytes: THEME_MAX_BYTES },
        );
        if (picked === null) return null;
        const bytes = new Uint8Array(picked.bytes);
        return { name: picked.fileName, size: bytes.length, read: async () => bytes };
      } catch (error) {
        // Acima do teto (NFR-15) nada é lido: a UI recusa pelo tamanho, sem chamar `read`.
        const big = tooLargePick(error);
        if (big === null) throw error;
        return {
          name: big.fileName,
          size: big.size,
          read: () => Promise.reject(new VaultError('TOO_LARGE', 'Arquivo grande demais.')),
        };
      }
    },
  };
}
