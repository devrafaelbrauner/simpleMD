import type { ExplorerIntensity, ExplorerScope, ExplorerStyle } from '@simplemd/themes';

/**
 * Textos do estilo do explorador (r13 D-R13-F5; arch-ux §1 STR-R13-*, DESIGN r13 §6.6), literais.
 * Os rótulos das opções seguem a ordem das listas de `@simplemd/themes`.
 */
export const EXPLORER_STYLE_LABELS: Readonly<Record<ExplorerStyle, string>> = {
  dot: 'Bolinha',
  stripe: 'Faixa lateral',
  card: 'Cartão',
  gradient: 'Cartão com degradê',
};

export const EXPLORER_INTENSITY_LABELS: Readonly<Record<ExplorerIntensity, string>> = {
  subtle: 'Sutil',
  medium: 'Média',
  strong: 'Forte',
};

export const EXPLORER_SCOPE_LABELS: Readonly<Record<ExplorerScope, string>> = {
  own: 'Só pastas com cor',
  inherit: 'Também subpastas, em tom mais claro',
};

/** STR-R13-02: dica do Estilo. */
export const STR_EXPLORER_STYLE_HINT =
  'Como as pastas com cor aparecem no explorador. As abas não mudam.';

/** STR-R13-03: dica do arco-íris. */
export const STR_EXPLORER_RAINBOW_HINT =
  'Dá às pastas do topo as 8 cores em sequência, na ordem do explorador. Pastas com cor própria mantêm a sua. Criar, apagar ou renomear uma pasta do topo pode mudar as cores das seguintes. Nada é gravado nas pastas.';

/** STR-R13-04: por que Intensidade e Onde aplicar estão desabilitados em Bolinha. */
export const STR_EXPLORER_DOT_HINT =
  'Intensidade e Onde aplicar valem para Faixa lateral, Cartão e Cartão com degradê.';

/** STR-R13-05: dica do Onde aplicar. */
export const STR_EXPLORER_SCOPE_HINT = 'Notas nunca são coloridas.';

/** STR-R13-06: sufixo do nome da bolinha de cor automática ("cor rosa, automática"). */
export const STR_AUTO_COLOR_SUFFIX = ', automática';
