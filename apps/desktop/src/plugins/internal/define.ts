import type { PluginAPI } from '@simplemd/plugin-api';

/**
 * Tipos e `defineInternalPlugin` do registro dos plugins internos (r7 D-R7-F01). Ficam fora do
 * coletor (`index.ts`) e fora do glob dele: cada descritor `./<id>.ts` importa só este arquivo, então
 * não há import circular descritor ↔ coletor e um descritor pode ser importado sozinho (CR-S0-01).
 */

/** O que o registro entrega ao `load` de UM plugin (menor privilégio: cada plugin recebe o seu). */
export interface InternalLoadContext {
  readonly pluginId: string;
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
  load(ctx: InternalLoadContext): Promise<InternalPluginModule>;
}

/** Identidade tipada: o descritor de `./<id>.ts` (`export default defineInternalPlugin({ … })`). */
export function defineInternalPlugin(
  descriptor: InternalPluginDescriptor,
): InternalPluginDescriptor {
  return descriptor;
}
