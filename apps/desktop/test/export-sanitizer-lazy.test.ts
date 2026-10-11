// @vitest-environment jsdom
// NFR-54 (r7 bundle): o sanitizador do HTML cru é um pedaço sob demanda. A exportação ESPERA a
// carga antes de renderizar: enquanto o pedaço não chegou, nada sai; quando chega, o HTML cru sai
// pela política (nunca como texto cru nem sem sanitizar).
import { loadHtmlSanitizer } from '@simplemd/core';
import { describe, expect, test, vi } from 'vitest';
import { exportHtml } from '../src/export/pipeline';

/** O pedaço só termina de carregar quando o teste libera; `entered` = a carga começou. */
const chunk = vi.hoisted(() => {
  const entered = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  return { evaluated: 0, entered, gate };
});
vi.mock('../../../packages/core/src/sanitize/sanitizer', async (importOriginal) => {
  chunk.evaluated++;
  chunk.entered.resolve();
  await chunk.gate.promise;
  return importOriginal();
});

describe('NFR-54: a exportação espera o sanitizador', () => {
  test('HTML cru: o documento só sai depois do pedaço, já sanitizado', async () => {
    const doc = '# T\n\n<p>ok <b>forte</b><script>window.__xss = 1</script></p>\n\nfim\n';
    let settled = false;
    const html = exportHtml(doc, 'n.md', () => false).then((out) => {
      settled = true;
      return out;
    });
    // A carga começou e está presa no portão: a exportação ainda não terminou.
    await chunk.entered.promise;
    expect(settled).toBe(false);

    chunk.gate.resolve();
    const out = await html;
    const body = new DOMParser().parseFromString(out, 'text/html').body;
    expect(body.querySelector('p b')?.textContent).toBe('forte');
    expect(body.querySelector('script')).toBeNull();
    expect(out).not.toContain('&lt;b&gt;');
    expect('__xss' in window).toBe(false);
    // Uma instância por janela: a mesma da carga do editor; o pedaço foi avaliado uma vez.
    await loadHtmlSanitizer();
    expect(chunk.evaluated).toBe(1);
  });
});
