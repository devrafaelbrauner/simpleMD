/** Textos do outliner (arch-ux STR-174/STR-175, §7.2). */
export const OUTLINER_TEXT = {
  moveUp: 'Lista: Mover item para cima',
  moveDown: 'Lista: Mover item para baixo',
  indent: 'Lista: Indentar item',
  outdent: 'Lista: Desindentar item',
  fold: 'Lista: Dobrar item',
  unfold: 'Lista: Desdobrar item',
  foldAll: 'Lista: Dobrar tudo',
  unfoldAll: 'Lista: Desdobrar tudo',
  movedUp: 'Item movido para cima.',
  movedDown: 'Item movido para baixo.',
  indented: 'Item indentado.',
  outdented: 'Item desindentado.',
  folded: 'Item dobrado.',
  unfolded: 'Item desdobrado.',
  foldGuide: (item: string) => `Dobrar “${item}”`,
  unfoldPlaceholder: (item: string) => `Desdobrar “${item}”`,
  foldedCount: (n: number) => (n === 1 ? '1 item dobrado' : `${n} itens dobrados`),
  /** Frases do `codeFolding` do CM (STR-175). */
  phrases: { 'folded code': 'conteúdo dobrado', unfold: 'desdobrar' },
} as const;
