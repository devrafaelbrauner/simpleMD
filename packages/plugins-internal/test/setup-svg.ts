/**
 * O jsdom não faz layout de SVG; o Mermaid mede textos com `getBBox`/`getComputedTextLength`.
 * Estes stubs dão medidas proporcionais ao texto, o bastante para o Mermaid montar o SVG real.
 */
if (typeof SVGElement !== 'undefined') {
  const proto = SVGElement.prototype as SVGElement & {
    getBBox?: () => DOMRect;
    getComputedTextLength?: () => number;
  };
  const size = (el: Element) => {
    const text = el.textContent ?? '';
    return { width: Math.max(1, text.length * 8), height: 16 };
  };
  proto.getBBox = function getBBox(this: SVGElement) {
    const { width, height } = size(this);
    return {
      x: 0,
      y: 0,
      width,
      height,
      top: 0,
      left: 0,
      right: width,
      bottom: height,
      toJSON: () => ({}),
    } as DOMRect;
  };
  proto.getComputedTextLength = function getComputedTextLength(this: SVGElement) {
    return size(this).width;
  };
}
