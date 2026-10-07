import type { InternalPlugin } from '@simplemd/plugin-api/runtime';

/**
 * Plugins internos (etapa 7; arch-frontend r2 §7.1, STR-83): mesmo `PluginHost.activate` dos
 * externos, com origem "internal" (sem aprovação nem aviso). Cada um é um chunk carregado sob
 * demanda; Mermaid e KaTeX carregam a biblioteca só quando há um bloco visível.
 */
export function internalPlugins(appVersion: string): InternalPlugin[] {
  const manifest = (id: string, name: string, description: string) => ({
    id,
    name,
    version: appVersion,
    minAppVersion: '0.0.0',
    main: 'index.ts',
    description,
  });
  return [
    {
      manifest: manifest(
        'simplemd.mermaid',
        'Diagramas Mermaid',
        'Desenha blocos mermaid como diagramas.',
      ),
      load: () => import('@simplemd/plugins-internal/mermaid'),
    },
    {
      manifest: manifest('simplemd.katex', 'Fórmulas KaTeX', 'Mostra fórmulas entre $ e $$.'),
      load: () => import('@simplemd/plugins-internal/katex'),
    },
    {
      manifest: manifest('simplemd.calc', 'Cálculo', 'Mostra o resultado de expressões como =2+3.'),
      load: () => import('@simplemd/plugins-internal/calc'),
    },
  ];
}
