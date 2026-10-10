// Portado de retronav/ixora@1734bce24307fd80c4ea538257efb6f612dc9715 (Apache-2.0), © Pranav Karawale. Modificado para o simpleMD.
// Origem: packages/ixora/src/plugins/image.ts + state/image.ts (`extractImages`: alt e URL do nó
// `Image`; nó escondido fora do cursor). Mudanças: destino só do vault (relativo à nota, `/` = raiz,
// referência `![a][r]`), esquemas ficam texto (U-4), recusas decididas antes de ler, imagem sozinha
// no parágrafo = contribuidor de bloco com a prévia mantida abaixo da linha crua (UX-R7-D4).
import type { Text } from '@codemirror/state';
import { Decoration } from '@codemirror/view';
import type { SyntaxNode } from '@lezer/common';
import { resolveVaultPath } from '../../links/vault-path';
import type { BlockContributor } from '../block';
import type { InlineContributor } from '../context';
import { refKey, stripAngle, type LinkReferences } from '../references';
import { ImageWidget, type ImageSpec } from './widget';

const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;
/** Os 5 tipos da leitura binária (extensão sem caixa; os bytes o provider confere). */
const IMAGE_EXT = /\.(?:png|jpe?g|gif|webp|svg)$/i;

/** Texto entre as aspas/parênteses de um `LinkTitle`. */
function titleOf(doc: Text, node: SyntaxNode | null): string | null {
  if (!node) return null;
  const raw = doc.sliceString(node.from, node.to);
  return raw.length >= 2 ? raw.slice(1, -1) : null;
}

/**
 * Lê o nó `Image` (R-I1.7): `![alt](caminho "título")`, `![alt](<com espaços>)`, `![alt][ref]`.
 * `null` = continua texto: esquema (`https:`, `data:`, `file:`…; 0 requisições), referência sem
 * definição, nó incompleto. Fora do vault/oculto → recusa "fora da pasta" sem leitura; extensão fora
 * dos 5 tipos → "tipo não suportado" sem leitura.
 */
export function readImage(
  node: SyntaxNode,
  doc: Text,
  refs: LinkReferences,
  notePath: string | null,
): ImageSpec | null {
  const marks = node.getChildren('LinkMark');
  const open = marks[0];
  const close = marks.find((m) => doc.sliceString(m.from, m.to) === ']');
  if (!open || !close) return null;
  const alt = doc.sliceString(open.to, close.from);
  let raw: string | undefined;
  let title: string | null = null;
  const url = node.getChildren('URL').find((u) => u.from >= close.to);
  if (url) {
    raw = stripAngle(doc.sliceString(url.from, url.to));
    title = titleOf(doc, node.getChild('LinkTitle'));
  } else {
    const label = node.getChildren('LinkLabel').find((l) => l.from >= close.to);
    const key =
      label && label.to - label.from > 2 ? doc.sliceString(label.from + 1, label.to - 1) : alt;
    raw = refs.get(refKey(key));
  }
  if (raw === undefined || raw === '' || SCHEME.test(raw)) return null;
  let shown = raw;
  try {
    shown = decodeURIComponent(raw);
  } catch {
    // Escape inválido: mostra como escrito.
  }
  const base = { shown, alt, title, owner: notePath };
  const resolved = resolveVaultPath(raw, notePath);
  if (!resolved.ok)
    return { ...base, path: null, error: resolved.reason === 'outside' ? 'outside' : 'not-found' };
  if (!IMAGE_EXT.test(resolved.path)) return { ...base, path: resolved.path, error: 'bad-type' };
  return { ...base, path: resolved.path, error: null };
}

/** Parágrafo de topo cujo único conteúdo é uma imagem (vira bloco; DA-R7-5). */
function aloneImage(paragraph: SyntaxNode, doc: Text): SyntaxNode | null {
  const image = paragraph.firstChild;
  if (!image || image.name !== 'Image' || image.nextSibling) return null;
  const text = doc.sliceString(paragraph.from, paragraph.to);
  return text.trim().length === image.to - image.from ? image : null;
}

/** A imagem é a de um bloco (parágrafo de topo só com ela)? O campo de blocos cuida dela. */
function isBlockImage(image: SyntaxNode, doc: Text): boolean {
  const paragraph = image.parent;
  return (
    paragraph !== null &&
    paragraph.name === 'Paragraph' &&
    paragraph.parent?.parent === null &&
    aloneImage(paragraph, doc) === image
  );
}

/**
 * Imagem em linha (com texto em volta, ou fora do topo): widget no lugar do nó fora do cursor;
 * cursor no nó → só o cru (UX-R7-D4).
 */
export const inlineImages: InlineContributor = {
  nodes: ['Image'],
  enter(node, ctx) {
    if (!ctx.once(node) || ctx.isTouched(node.from, node.to)) return;
    if (isBlockImage(node, ctx.doc)) return;
    const spec = readImage(node, ctx.doc, ctx.refs, ctx.notePath);
    if (!spec) return;
    ctx.out.push(
      Decoration.replace({ widget: new ImageWidget(spec, false) }).range(node.from, node.to),
    );
  },
};

/**
 * Imagem sozinha no parágrafo de topo (contribuidor de bloco): fora do cursor, a figura no lugar
 * da linha; com o cursor no nó, a linha crua volta e a figura fica logo abaixo (o texto anda no
 * máximo uma linha; UX-R7-D4).
 */
export const blockImages: BlockContributor = {
  nodes: ['Paragraph'],
  build(node, ctx) {
    const image = aloneImage(node, ctx.doc);
    if (!image) return null;
    const spec = readImage(image, ctx.doc, ctx.refs, ctx.notePath);
    if (!spec) return null;
    const from = ctx.doc.lineAt(node.from).from;
    const to = ctx.doc.lineAt(node.to).to;
    const widget = new ImageWidget(spec, true);
    if (ctx.isTouched(image.from, image.to))
      return Decoration.widget({ widget, block: true, side: 1 }).range(to);
    return Decoration.replace({ widget, block: true }).range(from, to);
  },
};
