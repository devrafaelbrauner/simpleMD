import { Facet } from '@codemirror/state';

/** Recusas visíveis de uma imagem do vault (R-I1.7; `cm-image[data-state]`). */
export type ImageError = 'not-found' | 'outside' | 'bad-type' | 'too-large';

/** Estado de uma imagem no serviço: carregando, pronta (URL `blob:`) ou recusada. */
export type ImageState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ok'; readonly url: string }
  | { readonly kind: 'error'; readonly error: ImageError };

/** Uma imagem pedida por um widget; `subscribe` devolve o cancelamento (o widget chama no destroy). */
export interface ImageHandle {
  readonly state: ImageState;
  subscribe(listener: (state: ImageState) => void): () => void;
}

/**
 * Serviço de imagens do app (arch-frontend r7 §4.1/§5.4, `imageSource`): uma cache por janela que
 * lê pelo provider (tipo, bytes mágicos e teto no gateway) e entrega URLs `blob:` só para `<img>`.
 * `owner` = caminho da nota que mostra a imagem (fechar a aba libera as dela).
 */
export interface ImageSource {
  request(path: string, owner: string | null): ImageHandle;
}

/** Sem serviço (demo, testes do núcleo): toda imagem do vault é "não encontrada" (R-I1.9). */
export const imageSourceFacet = Facet.define<ImageSource, ImageSource | null>({
  combine: (values) => values[0] ?? null,
});
