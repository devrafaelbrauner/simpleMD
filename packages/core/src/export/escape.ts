/**
 * Escape e lista de esquemas da exportação (R-10.4, D-15). Todo texto do documento passa por
 * {@link escapeHtml}; um `href`/`src` só sai quando {@link safeUrl} o aceita.
 */
const ENTITIES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Texto ou valor de atributo entre aspas duplas, sem nenhuma marcação viva. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ENTITIES[char] ?? char);
}

const SCHEME = /^([a-z][a-z0-9+.-]*):/;
const LINK_SCHEMES: Record<string, true> = { http: true, https: true, mailto: true };
const IMAGE_SCHEMES: Record<string, true> = { http: true, https: true };

/**
 * URL permitida (R-10.4): links só `http:`, `https:`, `mailto:` ou relativos; imagens só `http:`,
 * `https:` ou relativas. Qualquer outro esquema (`javascript:`, `data:`, `file:`…) → `null`, e
 * quem chama mostra o texto. Navegadores ignoram espaços e controles dentro do esquema
 * (`java\tscript:`), então a checagem é feita sem eles.
 */
export function safeUrl(raw: string, kind: 'link' | 'image'): string | null {
  const url = raw.trim();
  const probe = [...url]
    .filter((char) => char.charCodeAt(0) > 32)
    .join('')
    .toLowerCase();
  const scheme = SCHEME.exec(probe)?.[1];
  if (scheme === undefined) return url;
  return (kind === 'link' ? LINK_SCHEMES : IMAGE_SCHEMES)[scheme] ? url : null;
}

/** Saída de um renderizador injetado que traz script, `on*=` ou `javascript:` é descartada. */
export const UNSAFE_RENDER = /<script|\son[a-z]+\s*=|javascript:/i;
