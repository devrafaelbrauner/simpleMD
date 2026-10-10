import { Facet } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import type { LinkTarget } from './target';

/**
 * Serviço único de "abrir link" (arch-frontend r7 §5.5; `linkOpener` do `appExtensions`): o app o
 * implementa em `apps/desktop/src/app/link-opener.ts` e o reaproveita em I-2, I-10, I-5 e I-9.
 */
export interface LinkOpener {
  /** `view` = o editor de onde veio o gesto (rolagem até o `#título` depois de abrir a nota). */
  open(target: LinkTarget, view: EditorView): void;
  /** "Abrir link sob o cursor" sem link: aviso info "Nenhum link sob o cursor." (STR-137). */
  noLink(): void;
}

/** Sem serviço (demo, testes do núcleo): nada abre e o ⌘/Ctrl-clique segue o padrão do CM. */
export const linkOpenerFacet = Facet.define<LinkOpener, LinkOpener | null>({
  combine: (values) => values[0] ?? null,
});
