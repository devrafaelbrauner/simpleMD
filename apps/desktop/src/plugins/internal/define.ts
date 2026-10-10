import type { PluginAPI } from '@simplemd/plugin-api';
import type { InternalHostContext } from '@simplemd/plugin-api/internal/host';
import type { InternalEnabledNote, PluginOptionSpec } from '@simplemd/plugin-api/runtime';
import type { CatalogController } from '../../catalog/catalog';
import type { EditorAssembly } from '../../editor/assembly';
import type { AppPlatform } from '../../platform/types';
import type { DocumentRegistry } from '../../state/documents';
import type { AppStore } from '../../state/store';
import type { SyncController } from '../../state/sync';

/**
 * Tipos e `defineInternalPlugin` do registro dos plugins internos (r7 D-R7-F01). Ficam fora do
 * coletor (`index.ts`) e fora do glob dele: cada descritor `./<id>.ts` importa só este arquivo, então
 * não há import circular descritor ↔ coletor e um descritor pode ser importado sozinho (CR-S0-01).
 */

/**
 * Objetos do app que o ARQUIVO DE REGISTRO usa (DA-R7-26), nunca o código do plugin: o registro do
 * `simplemd.tasks` monta o catálogo de tarefas a partir deles, por closure no próprio arquivo.
 */
export interface InternalAppServices {
  readonly platform: AppPlatform;
  readonly store: AppStore;
  readonly registry: DocumentRegistry;
  readonly catalog: CatalogController;
  readonly sync: SyncController;
  readonly editor: EditorAssembly;
}

/** O que o registro entrega ao `load` de UM plugin (menor privilégio: cada plugin recebe o seu). */
export interface InternalLoadContext {
  readonly pluginId: string;
  /** Vai para o código do plugin (montado por plugin em `runtime.ts`, `contextFor`). */
  readonly host: InternalHostContext;
  /** Fica no arquivo de registro (DA-R7-26). */
  readonly services: InternalAppServices;
}

/** Módulo de um plugin interno: o mesmo `activate` (um argumento) dos plugins externos. */
export interface InternalPluginModule {
  readonly default: (api: PluginAPI) => void | (() => void);
}

export interface InternalPluginDescriptor {
  readonly id: `simplemd.${string}`;
  readonly name: string;
  readonly description: string;
  /** Ligado num vault sem escolha explícita (D-R7-P01; igual a `INTERNAL_PLUGIN_DEFAULTS`). */
  readonly defaultEnabled: boolean;
  /** Ordem de ativação = ordem das extensões no editor (mermaid 10 … languagetool 90). */
  readonly order: number;
  /** Opções no gerenciador (R-X7.4, DA-R7-12), no `data.json` do `api.settings`. */
  readonly options?: readonly PluginOptionSpec[];
  /** Linha de motivo enquanto ligado (LT-ENABLE: STR-170 + "Como instalar"). */
  readonly enabledNote?: InternalEnabledNote;
  load(ctx: InternalLoadContext): Promise<InternalPluginModule>;
}

/** Identidade tipada: o descritor de `./<id>.ts` (`export default defineInternalPlugin({ … })`). */
export function defineInternalPlugin(
  descriptor: InternalPluginDescriptor,
): InternalPluginDescriptor {
  return descriptor;
}
