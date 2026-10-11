export interface CssRule {
  selector: string;
  body: string;
}

/**
 * Regras CSS que os temas do CodeMirror montaram no documento (no jsdom o `style-mod` escreve uma
 * `<style>` no `<head>`). Sem layout: confere o contrato do tema, não a geometria (essa é do PW).
 */
export function mountedCssRules(): CssRule[] {
  const text = [...document.head.querySelectorAll('style')].map((s) => s.textContent).join('\n');
  return [...text.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
    selector: (m[1] ?? '').trim(),
    body: (m[2] ?? '').trim(),
  }));
}

/**
 * Corpo da ÚLTIMA regra (a que vence o empate de especificidade: temas base vêm antes) cujo
 * seletor, sem o escopo `.ͼN`, é exatamente `selector`; erro se não houver.
 */
export function ruleBody(rules: readonly CssRule[], selector: string): string {
  const found = rules.filter((r) => r.selector.replace(/^\.ͼ[0-9a-z]+ ?/, '') === selector);
  if (found.length === 0) throw new Error(`regra não montada: ${selector}`);
  return found[found.length - 1]!.body;
}
