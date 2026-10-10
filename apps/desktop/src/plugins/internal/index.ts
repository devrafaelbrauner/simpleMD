import type { PluginManifest } from '@simplemd/plugin-api';
import type { InternalPlugin } from '@simplemd/plugin-api/runtime';
import type { InternalLoadContext, InternalPluginDescriptor } from './define';

export type {
  InternalAppServices,
  InternalLoadContext,
  InternalPluginDescriptor,
  InternalPluginModule,
} from './define';

/**
 * Registro dos plugins internos, um arquivo por plugin (r7 D-R7-F01/D-R7-S05; arch-frontend r7
 * §3.1). Cada `./<id>.ts` deste diretório (menos este coletor e `define.ts`) exporta por padrão um
 * descritor feito com `defineInternalPlugin`; este coletor junta todos por `import.meta.glob`
 * (eager). O descritor é minúsculo: nome, descrição e padrão aparecem sem baixar o plugin; o código
 * do plugin só chega no `import()` dentro de `load` (chunk sob demanda, 0 bytes de plugin desligado).
 */
const modules = import.meta.glob<unknown>(['./*.ts', '!./index.ts', '!./define.ts'], {
  eager: true,
  import: 'default',
});

/**
 * Confere o `export default` de cada arquivo do glob (CR-S0-11): um arquivo sem descritor válido
 * é erro de programação, com o nome do arquivo, em vez de um `TypeError` na ordenação.
 */
export function collectDescriptors(found: Record<string, unknown>): InternalPluginDescriptor[] {
  return Object.entries(found)
    .map(([file, value]) => {
      const d = value as Partial<InternalPluginDescriptor> | null | undefined;
      if (
        typeof d?.id !== 'string' ||
        !d.id.startsWith('simplemd.') ||
        typeof d.order !== 'number' ||
        typeof d.load !== 'function'
      )
        throw new Error(
          `plugins/internal/${file.replace(/^\.\//, '')}: o export default não é um descritor de defineInternalPlugin (helpers ficam fora desta pasta ou em define.ts).`,
        );
      return d as InternalPluginDescriptor;
    })
    .sort((a, b) => a.order - b.order);
}

/** Todos os descritores, na ordem de ativação. */
export function internalPluginDescriptors(): InternalPluginDescriptor[] {
  return collectDescriptors(modules);
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
 * aviso nem aprovação; etapa 7), com o padrão, as opções e a linha de motivo do descritor (r7).
 * `contextFor` monta o contexto de cada plugin (obrigatório: `runtime.ts`); `descriptors` só muda
 * no harness (H27: `load` com atraso/falha injetados).
 */
export function internalPlugins(
  appVersion: string,
  contextFor: (descriptor: InternalPluginDescriptor) => InternalLoadContext,
  descriptors: readonly InternalPluginDescriptor[] = internalPluginDescriptors(),
): InternalPlugin[] {
  return descriptors.map((descriptor) => ({
    manifest: internalPluginManifest(descriptor, appVersion),
    defaultEnabled: descriptor.defaultEnabled,
    ...(descriptor.options ? { options: descriptor.options } : {}),
    ...(descriptor.enabledNote ? { enabledNote: descriptor.enabledNote } : {}),
    load: () => descriptor.load(contextFor(descriptor)),
  }));
}
