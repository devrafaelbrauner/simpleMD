import { STYLE_PROPS } from './policy';

const ALLOWED: Readonly<Record<string, true>> = Object.fromEntries(
  STYLE_PROPS.map((property) => [property, true]),
);

/**
 * Caracteres de um valor aceito: letras, dígitos, `#`, `%`, `.`, `,`, `(`, `)`, `/`, `-` e
 * espaço. Fora ficam aspas, `\` (escapes CSS), `@`, `!` (`!important`), `;`, `:`, `*` (comentário),
 * `<`/`>` e qualquer controle — sem eles não há `url("…")`, escape nem quebra de declaração.
 */
const SAFE_VALUE = /^[a-zA-Z0-9#%.,()/ -]+$/;
/** Funções de cor aceitas; qualquer outra (`url`, `var`, `expression`, `image-set`, `env`…) recusa. */
const COLOR_FUNCTIONS: Readonly<Record<string, true>> = {
  rgb: true,
  rgba: true,
  hsl: true,
  hsla: true,
  hwb: true,
  lab: true,
  lch: true,
  oklab: true,
  oklch: true,
};
/** Teto de um valor e do atributo inteiro (nada legítimo chega perto). */
const MAX_VALUE = 200;
const MAX_STYLE = 2000;

/** O valor fica? (R-I10.1: sem `url(`, `expression`, `var(`, `!important`, `\`, `@`). */
function valueAllowed(value: string): boolean {
  if (value === '' || value.length > MAX_VALUE || !SAFE_VALUE.test(value)) return false;
  const lower = value.toLowerCase();
  // `url(`, `var(`, `image-set(`… caem na lista de funções; `expression` (IE) sai em qualquer forma.
  if (lower.includes('expression')) return false;
  for (const [, name = ''] of lower.matchAll(/([a-z-]*)\s*\(/g)) {
    if (COLOR_FUNCTIONS[name] !== true) return false;
  }
  // Parênteses desbalanceados não são uma função de cor.
  let depth = 0;
  for (const char of value) {
    if (char === '(') depth++;
    else if (char === ')' && --depth < 0) return false;
  }
  return depth === 0;
}

/**
 * `style` re-serializado (R-I10.1, R-I10.3): só as 6 propriedades de {@link STYLE_PROPS}, cada
 * uma com valor na forma segura; a última ocorrência vence. Nada de `position`, `z-index`,
 * `transform`, tamanhos, `url()` ou variáveis: o conteúdo não sai da caixa do widget nem busca
 * nada. `''` quando nada fica (o atributo sai).
 */
export function sanitizeStyle(raw: string): string {
  if (raw.length > MAX_STYLE) return '';
  const kept = new Map<string, string>();
  for (const declaration of raw.split(';')) {
    const colon = declaration.indexOf(':');
    if (colon < 0) continue;
    const property = declaration.slice(0, colon).trim().toLowerCase();
    const value = declaration
      .slice(colon + 1)
      .trim()
      .replace(/\s+/g, ' ');
    if (ALLOWED[property] !== true || !valueAllowed(value)) continue;
    kept.delete(property);
    kept.set(property, value);
  }
  return [...kept].map(([property, value]) => `${property}: ${value}`).join('; ');
}
