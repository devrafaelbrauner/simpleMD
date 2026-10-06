/**
 * O jsdom não implementa a medição de layout que o ciclo de medida do CodeMirror chama.
 * Os stubs só são instalados quando há DOM (testes com `// @vitest-environment jsdom`).
 */
if (typeof Range !== 'undefined') {
  const emptyRect = (): DOMRect => ({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    width: 0,
    height: 0,
    toJSON: () => ({}),
  });
  const emptyRects = (): DOMRectList => {
    const list: DOMRect[] = [];
    return Object.assign(list, { item: (i: number) => list[i] ?? null }) as unknown as DOMRectList;
  };
  Range.prototype.getBoundingClientRect = emptyRect;
  Range.prototype.getClientRects = emptyRects;
  Element.prototype.getClientRects = emptyRects;
}
