import type { Extension } from '@codemirror/state';
import { appPlatformFacet, type EditorPlatform } from '@simplemd/core';
import type { AppPlatform } from '../platform/types';
import type { AppStore } from '../state/store';

/** O que os serviços do editor recebem do app (uma janela = um conjunto). */
export interface EditorServiceDeps {
  readonly platform: AppPlatform;
  readonly store: AppStore;
  readonly os: EditorPlatform;
}

/**
 * Facets de serviço do app para o editor principal (arch-frontend r7 §4.1, `appExtensions` do
 * `EditorHost`): estáveis por janela, nunca reconfiguradas (cada serviço troca de vault por
 * dentro). Ponto de registro ST → S1 → S2 → S9: uma linha por serviço no fim do array (e, se
 * precisar, um campo no fim de `EditorServiceDeps`).
 */
export function createEditorServices(deps: EditorServiceDeps): Extension[] {
  return [
    // Plataforma: textos e teclas por sistema (alternador do modo de foco, atalho falado).
    appPlatformFacet.of(deps.os),
  ];
}
