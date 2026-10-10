import { Facet } from '@codemirror/state';

/** Plataforma do app para textos e teclas que mudam por sistema (⌥⇧M × Ctrl+M; arch-ux §6.1). */
export type EditorPlatform = 'mac' | 'other';

/**
 * Serviço de plataforma do editor (arch-frontend r7 §4.1, `appExtensions`): o app declara uma vez
 * em `apps/desktop/src/editor/services.ts`. Sem declaração (testes do núcleo), `other`.
 */
export const appPlatformFacet = Facet.define<EditorPlatform, EditorPlatform>({
  combine: (values) => values[0] ?? 'other',
});
