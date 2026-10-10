import type { Extension } from '@codemirror/state';
import {
  appPlatformFacet,
  imageSourceFacet,
  linkOpenerFacet,
  type EditorPlatform,
} from '@simplemd/core';
import { createLinkOpener } from '../app/link-opener';
import type { AppPlatform } from '../platform/types';
import type { AppStore } from '../state/store';
import type { SyncController } from '../state/sync';
import { createImageService } from './image-service';

/** O que os serviços do editor recebem do app (uma janela = um conjunto). */
export interface EditorServiceDeps {
  readonly platform: AppPlatform;
  readonly store: AppStore;
  readonly os: EditorPlatform;
  /** Sincronização (abrir nota no app); lida tarde porque nasce depois do editor. */
  readonly sync: () => SyncController;
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
    // Imagens do vault: uma cache por janela, `blob:` só em `<img>` (S1, R-I1.7).
    imageSourceFacet.of(createImageService(deps)),
    // Serviço único de "abrir link" (S1, R-I1.2/R-I2.6).
    linkOpenerFacet.of(createLinkOpener(deps)),
  ];
}
