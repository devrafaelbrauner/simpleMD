import type { RequiredToken } from '@simplemd/themes';

/** Rótulos pt-BR dos 11 tokens obrigatórios (arch-ux §2.4). Só nomes: nenhum valor aqui (T-12). */
export const TOKEN_LABELS: Record<RequiredToken, string> = {
  '--color-bg': 'Fundo',
  '--color-fg': 'Texto',
  '--color-muted': 'Texto secundário',
  '--color-accent': 'Destaque',
  '--color-border': 'Bordas',
  '--color-selection': 'Seleção',
  '--color-sidebar-bg': 'Fundo da barra lateral',
  '--color-code-bg': 'Fundo de código',
  '--fontFamily-ui': 'Fonte da interface',
  '--fontFamily-mono': 'Fonte do editor',
  '--dimension-font-size': 'Tamanho da fonte (px)',
};
