/**
 * Lê as declarações de propriedades customizadas dos blocos `:root { … }` de uma folha de tokens
 * (arch-frontend §7.1). Os valores são mantidos como estão no arquivo (só `trim`), então o tema
 * claro embutido tem exatamente os valores de `tokens.css`: uma única fonte de valores (D-1).
 * Aceita `\r\n` (checkout no Windows) e ignora comentários.
 */
export function parseTokensCss(raw: string): Record<string, string> {
  const css = raw.replace(/\/\*[\s\S]*?\*\//g, '');
  const tokens: Record<string, string> = {};
  for (const [, body = ''] of css.matchAll(/:root\s*\{([^}]*)\}/g)) {
    for (const [, name = '', value = ''] of body.matchAll(/(--[A-Za-z0-9_-]+)\s*:\s*([^;]*);/g)) {
      tokens[name] = value.trim();
    }
  }
  return tokens;
}
