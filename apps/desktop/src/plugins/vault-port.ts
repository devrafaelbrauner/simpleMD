import {
  MAIN_MAX_BYTES,
  MANIFEST_MAX_BYTES,
  PLUGINS_DIR,
  SETTINGS_MAX_BYTES,
  type PluginDirPort,
  type PluginSettingsPort,
  type PluginVaultSession,
} from '@simplemd/plugin-api/runtime';
import {
  ConflictError,
  isJsonObject,
  isVaultError,
  sha256Hex,
  toVaultPath,
  updateJsonFile,
  VaultError,
  type ContentBase,
  type ContentVaultProvider,
  type VaultHandle,
} from '@simplemd/vault';
import type { DocStatus } from '../state/store';

const encoder = new TextEncoder();
const MD = /\.md$/i;

/**
 * Guarda de caminho dos plugins (arch-backend r2 §1.3.6), ANTES de qualquer chamada à porta:
 * `toVaultPath` (absoluto, `..`, controle…), nenhum segmento oculto (inclusive `.simplemd/`) e só
 * `.md`. Links que escapam a raiz são recusados pela caminhada do provider (só `lstat` internos).
 */
function guard(path: string): string {
  const rel = toVaultPath(path);
  if (rel.split('/').some((segment) => segment.startsWith('.')))
    throw new VaultError('PERMISSION_DENIED', 'Plugins não acessam pastas ocultas.', { path: rel });
  if (!MD.test(rel))
    throw new VaultError('INVALID_PATH', 'Plugins só leem e gravam notas .md.', { path: rel });
  return rel;
}

export interface PluginVaultDeps {
  readonly provider: ContentVaultProvider;
  readonly handle: VaultHandle;
  /** Status da aba que tem o arquivo aberto (se houver). */
  tabStatus(path: string): DocStatus | undefined;
  /** Depois de uma gravação: relista/recarrega a aba limpa e emite `vault:change` (R-6.15). */
  afterWrite(path: string, created: boolean): void;
}

/**
 * `api.vault` de um plugin (R-6.14, R-6.15, D-13). Sobrescrever exige que ESTE plugin tenha lido o
 * arquivo nesta sessão e que o disco ainda tenha o que ele leu (base de conteúdo, RR-03); uma aba
 * com edições pendentes recusa com `ConflictError` e o buffer fica intacto.
 */
export function createPluginVaultSession(deps: PluginVaultDeps): PluginVaultSession {
  const { provider, handle } = deps;
  const bases = new Map<string, ContentBase>();
  const base = (text: string, mtime: number): ContentBase => ({
    sha256: sha256Hex(encoder.encode(text)),
    mtime,
  });
  return {
    async list() {
      const entries = await provider.list(handle);
      return entries
        .filter((entry) => entry.kind === 'file')
        .map((entry) => entry.path)
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    },
    async read(path) {
      const rel = guard(path);
      // Sempre o texto do DISCO (nunca o buffer de uma aba suja). O decodificador mantém o BOM,
      // então recodificar devolve os mesmos bytes e o hash da base confere.
      const { text, mtime } = await provider.read(handle, rel);
      bases.set(rel, base(text, mtime));
      return text;
    },
    async write(path, text) {
      const rel = guard(path);
      const status = deps.tabStatus(rel);
      if (status === 'dirty' || status === 'saving' || status === 'conflict')
        throw new ConflictError(rel, bases.get(rel)?.mtime ?? 0, null, 'modified');
      const stat = await provider.stat(handle, rel);
      if (stat === null) {
        // Caminho novo: só cria, e a pasta precisa existir (plugins não criam pastas).
        const slash = rel.lastIndexOf('/');
        if (slash !== -1) {
          const parent = await provider.stat(handle, rel.slice(0, slash));
          if (parent?.kind !== 'dir')
            throw new VaultError('NOT_FOUND', 'A pasta da nota não existe.', { path: rel });
        }
        let mtime: number;
        try {
          ({ mtime } = await provider.write(handle, rel, text));
        } catch (error) {
          if (isVaultError(error, 'ALREADY_EXISTS'))
            throw new ConflictError(rel, 0, null, 'modified');
          throw error;
        }
        bases.set(rel, base(text, mtime));
        deps.afterWrite(rel, true);
        return;
      }
      const known = bases.get(rel);
      if (!known) throw new ConflictError(rel, 0, stat.mtime, 'modified');
      const { mtime } = await provider.writeIfUnchanged(handle, rel, text, known);
      bases.set(rel, base(text, mtime));
      deps.afterWrite(rel, false);
    },
    dispose() {
      bases.clear();
    },
  };
}

/** Porta de descoberta sobre o provider: 0 leituras de `main.js` (só `stat`). */
export function createPluginDirPort(
  provider: ContentVaultProvider,
  handle: VaultHandle,
): PluginDirPort {
  return {
    async listPluginFolders() {
      try {
        return await provider.listChildren(handle, PLUGINS_DIR);
      } catch (error) {
        if (isVaultError(error, 'NOT_FOUND')) return [];
        throw error;
      }
    },
    async readManifest(folder) {
      const path = `${PLUGINS_DIR}/${folder}/manifest.json`;
      return (await provider.readBytes(handle, path, { maxBytes: MANIFEST_MAX_BYTES })).bytes;
    },
    async statMain(folder, main) {
      const stat = await provider.stat(handle, `${PLUGINS_DIR}/${folder}/${main}`);
      return stat?.kind === 'file' ? { size: stat.size } : null;
    },
  };
}

/** Lê o `main` UMA vez (teto de 5 MB, sem ler acima dele). */
export async function readPluginMain(
  provider: ContentVaultProvider,
  handle: VaultHandle,
  folder: string,
  main: string,
): Promise<Uint8Array> {
  const path = `${PLUGINS_DIR}/${folder}/${main}`;
  return (await provider.readBytes(handle, path, { maxBytes: MAIN_MAX_BYTES })).bytes;
}

/**
 * `data.json` de cada plugin (arch-backend r2 §1.3.5): carregado antes de `activate`; ilegível ou
 * acima de 1 MB → `{}` e nunca sobrescrito (`warn` avisa); gravação por ler-mesclar-gravar.
 */
export function createPluginSettingsPort(
  provider: ContentVaultProvider,
  handle: VaultHandle,
  warn: (pluginId: string) => void,
): PluginSettingsPort {
  const pathOf = (id: string) => `${PLUGINS_DIR}/${id}/data.json`;
  return {
    async load(id) {
      const path = pathOf(id);
      try {
        const stat = await provider.stat(handle, path);
        if (stat === null) return { values: {}, writable: true };
        if (stat.size > SETTINGS_MAX_BYTES) throw new SyntaxError('grande demais');
        const parsed: unknown = JSON.parse(
          (await provider.read(handle, path)).text.replace(/^\uFEFF/, ''),
        );
        if (!isJsonObject(parsed)) throw new SyntaxError('não é objeto');
        return { values: parsed, writable: true };
      } catch {
        warn(id);
        return { values: {}, writable: false };
      }
    },
    async save(id, key, value) {
      const result = await updateJsonFile(provider, handle, pathOf(id), (obj) => {
        if (value === undefined) delete obj[key];
        else obj[key] = value;
      });
      if (result.status === 'malformed') throw new Error('data.json deste plugin é inválido');
    },
  };
}
