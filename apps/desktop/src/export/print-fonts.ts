/**
 * Teto da espera pelas fontes (AC-W02.7, decisão W02-D1): passado isso, o painel abre assim mesmo
 * (o texto sai com a reserva, como antes) e o `Mod-P` → painel segue ≤ 4 000 ms (NFR-32).
 */
export const PRINT_FONTS_TIMEOUT_MS = 2_500;

/**
 * Fontes da visualização de impressão (W-02 / F-WIN-02). A raiz fica `display: none` na tela, então
 * nada nela pede fonte e `document.fonts.ready` resolve sem esperar nada; as faces que só ela usa
 * (KaTeX, `font-display: block`) seriam pedidas no layout de impressão e sairiam invisíveis no
 * instantâneo do painel. `getComputedStyle` vale em `display: none` e `fonts.load` não depende de
 * layout: carrega cada face usada (fonte calculada + caracteres do texto) antes do painel.
 */
export async function loadPrintFonts(
  root: HTMLElement,
  fonts: FontFaceSet = document.fonts,
): Promise<void> {
  const byFont = new Map<string, Set<string>>();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.nodeValue ?? '';
    const el = node.parentElement;
    if (!el || text.trim() === '') continue;
    const style = getComputedStyle(el);
    if (style.fontFamily === '') continue;
    const font = `${style.fontStyle} ${style.fontWeight} 16px ${style.fontFamily}`;
    let chars = byFont.get(font);
    if (!chars) byFont.set(font, (chars = new Set()));
    for (const ch of text) chars.add(ch);
  }
  // Uma fonte que não carrega não impede o painel (o texto sai com a reserva, como hoje).
  const loaded = Promise.allSettled(
    [...byFont].map(([font, chars]) => fonts.load(font, [...chars].join(''))),
  ).then(() => fonts.ready);
  let stop = () => {};
  const bound = new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, PRINT_FONTS_TIMEOUT_MS);
    stop = () => clearTimeout(timer);
  });
  try {
    await Promise.race([loaded, bound]);
  } finally {
    stop();
  }
}
