import type { ExportImage, ExportImages, ImageSource, ImageState } from '@simplemd/core';
import { collectExportImages } from '@simplemd/core/export';
import { IMAGE_MIME, sniffImage, type VaultImage } from '@simplemd/vault';
import { PRINT_FONTS_TIMEOUT_MS } from './print-fonts';

/** Teto do que é embutido num arquivo HTML exportado (§5 do product; AC-EX.1): 50 MiB. */
export const EXPORT_IMAGE_BUDGET = 50 * 1024 * 1024;

/** Mapa de imagens do vault da exportação (D-R7-S24) e quantas ficaram de fora pelo teto. */
export interface ExportImageMap {
  readonly images: ExportImages;
  /** Imagens que saíram só com o texto alternativo porque o teto foi atingido (aviso STR-183). */
  readonly omitted: number;
}

/** Texto do aviso STR-183 (warn). */
export function exportImagesNotice(omitted: number): string {
  const rest =
    omitted === 1
      ? '1 imagem ficou só com o texto alternativo.'
      : `${omitted} imagens ficaram só com o texto alternativo.`;
  return `Algumas imagens não foram embutidas: o arquivo exportado chegou a 50 MB. ${rest}`;
}

/** Base64 em pedaços (sem estourar a pilha de argumentos do `String.fromCharCode`). */
function base64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk)
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(binary);
}

/**
 * Arquivo HTML (AC-EX.1): cada imagem do vault, na ordem do documento, lida pelo provider (mesmos
 * limites e recusas do editor) e embutida como `data:<MIME>;base64,…` — o MIME é o do tipo
 * conferido e os bytes mágicos são conferidos de novo aqui; SVG vira `data:image/svg+xml` e só
 * aparece em `<img>`. Quando o próximo `data:` passaria do teto, ele e todas as seguintes saem como
 * texto alternativo (`omitted`). Recusada → texto alternativo, sem aviso.
 */
export async function embedImages(
  doc: string,
  notePath: string,
  read: (path: string) => Promise<VaultImage>,
  budget: number = EXPORT_IMAGE_BUDGET,
): Promise<ExportImageMap> {
  const map = new Map<string, ExportImage>();
  let used = 0;
  let omitted = 0;
  for (const path of collectExportImages(doc, notePath)) {
    if (omitted > 0) {
      map.set(path, { reason: 'over-budget' });
      omitted++;
      continue;
    }
    let image: VaultImage;
    try {
      image = await read(path);
    } catch {
      map.set(path, { reason: 'refused' });
      continue;
    }
    if (image.mime !== IMAGE_MIME[image.kind] || !sniffImage(image.kind, image.bytes)) {
      map.set(path, { reason: 'refused' });
      continue;
    }
    const src = `data:${image.mime};base64,${base64(image.bytes)}`;
    if (used + src.length > budget) {
      map.set(path, { reason: 'over-budget' });
      omitted++;
      continue;
    }
    used += src.length;
    map.set(path, { src });
  }
  return { images: { notePath, map }, omitted };
}

/**
 * Visualização de impressão (AC-EX.2): as imagens do vault vêm da cache da janela como `blob:`
 * (a mesma do editor; CSP do app `img-src 'self' blob:`). Sem cache, nenhuma aparece (texto
 * alternativo). Remotas continuam como texto alternativo (serializador). Cada imagem fica inscrita
 * na cache até `release()` (depois do `print()`): para o LRU ela conta como mostrada (CR-S1-05);
 * a troca de pasta resolve a espera como recusada, nada fica pendurado.
 */
export async function printImages(
  doc: string,
  notePath: string,
  source: ImageSource | null,
): Promise<{ readonly images: ExportImages; release(): void }> {
  const map = new Map<string, ExportImage>();
  const holds: Array<() => void> = [];
  if (source) {
    for (const path of collectExportImages(doc, notePath)) {
      const handle = source.request(path, notePath);
      let state = handle.state;
      if (state.kind === 'loading') {
        // Forma com executor de propósito: `Promise.withResolvers` não existe no WKWebView < 14.4
        // (CR-08).
        state = await new Promise<ImageState>((resolve) => {
          holds.push(
            handle.subscribe((next) => {
              if (next.kind !== 'loading') resolve(next);
            }),
          );
        });
      } else {
        holds.push(handle.subscribe(() => {}));
      }
      map.set(path, state.kind === 'ok' ? { src: state.url } : { reason: 'refused' });
    }
  }
  return {
    images: { notePath, map },
    release: () => {
      for (const stop of holds.splice(0)) stop();
    },
  };
}

/**
 * Espera as `<img>` da raiz de impressão decodificarem antes do painel (CR-S1-04): uma `blob:`
 * recém-inserida decodifica de forma assíncrona e o instantâneo do WKWebView sairia sem ela. Falha
 * de uma imagem não segura as outras; o teto é o mesmo das fontes de impressão.
 */
export async function decodeImages(
  root: HTMLElement,
  timeoutMs: number = PRINT_FONTS_TIMEOUT_MS,
): Promise<void> {
  const images = [...root.querySelectorAll('img')];
  if (images.length === 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Forma com executor de propósito: `Promise.withResolvers` não existe no WKWebView < 14.4 (CR-08).
  const limit = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  await Promise.race([
    Promise.all(images.map((img) => (img.decode ? img.decode().catch(() => {}) : undefined))),
    limit,
  ]);
  clearTimeout(timer);
}
