import type { PluginAPI, PluginManifest } from '@simplemd/plugin-api';
import type { InternalPlugin } from '@simplemd/plugin-api/runtime';

/**
 * Registro dos plugins internos, um arquivo por plugin (r7 D-R7-F01/D-R7-S05; arch-frontend r7
 * §3.1). Cada `./<id>.ts` deste diretório exporta por padrão um descritor feito com
 * `defineInternalPlugin`; este coletor junta todos por `import.meta.glob` (eager). O descritor é
 * minúsculo: nome, descrição e padrão aparecem sem baixar o plugin; o código do plugin só chega no
 * `import()` dentro de `load` (chunk sob demanda, 0 bytes de plugin desligado).
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

/**
 * Declaração de função (não `const`): os descritores importam isto de volta enquanto este módulo
 * ainda avalia o `import.meta.glob` (import circular); a função já existe nesse momento.
 */
export function defineInternalPlugin(
  descriptor: InternalPluginDescriptor,
): InternalPluginDescriptor {
  return descriptor;
}

const modules = import.meta.glob<InternalPluginDescriptor>(['./*.ts', '!./index.ts'], {
  eager: true,
  import: 'default',
});

/** Todos os descritores, na ordem de ativação. */
export function internalPluginDescriptors(): InternalPluginDescriptor[] {
  return Object.values(modules).sort((a, b) => a.order - b.order);
}

/** Manifesto do plugin interno (mesma forma dos externos; versão = a do app). */
export function internalPluginManifest(
  descriptor: InternalPluginDescriptor,
  appVersion: string,
): PluginManifest {
  return {
    id: descriptor.id,
    name: descriptor.name,
    version: appVersion,
    minAppVersion: '0.0.0',
    main: 'index.ts',
    description: descriptor.description,
  };
}

/**
 * Plugins internos para o `PluginHost` (mesmo `activate` dos externos, origem "internal", sem
 * aprovação nem aviso; etapa 7). `contextFor` monta o contexto de cada plugin.
 */
export function internalPlugins(
  appVersion: string,
  contextFor: (descriptor: InternalPluginDescriptor) => InternalLoadContext = (descriptor) => ({
    pluginId: descriptor.id,
  }),
): InternalPlugin[] {
  return internalPluginDescriptors().map((descriptor) => ({
    manifest: internalPluginManifest(descriptor, appVersion),
    load: () => descriptor.load(contextFor(descriptor)),
  }));
}
