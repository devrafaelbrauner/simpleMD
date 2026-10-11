import type { Plugin } from 'vite';

/**
 * r7 S5 (D-R7-S5-05, CR-S5-09): plugins dos bundles de worker, usados por `vite.config.ts` (app) e
 * `vite.harness.config.ts` (harness = mesma UI).
 *
 * O worker do lint (markdownlint → micromark) importa `decode-named-character-reference`, cujo
 * `exports` tem `"browser": "./index.dom.js"` (usa `document`) e `"worker": "./index.js"`. O Vite
 * resolve o worker com a condição `browser` e no worker não há `document`; SÓ nos bundles de
 * worker, a resolução vai para a variante de worker do próprio pacote. Se uma versão nova do pacote
 * mudar esses nomes, o build FALHA aqui, em vez de o worker morrer em produção e o lint cair em
 * silêncio no plano C (`test/vite-worker-plugins.test.ts` confere os arquivos do pacote instalado).
 */
export const DOM_VARIANT = 'index.dom.js';
export const WORKER_VARIANT = 'index.js';

export function workerWithoutDom(): Plugin {
  return {
    name: 'simplemd:worker-sem-dom',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      if (source !== 'decode-named-character-reference') return null;
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      const id = resolved?.id ?? '';
      if (resolved && id.endsWith(`/${DOM_VARIANT}`))
        return { ...resolved, id: id.slice(0, -DOM_VARIANT.length) + WORKER_VARIANT };
      if (resolved && id.endsWith(`/${WORKER_VARIANT}`)) return resolved;
      throw new Error(
        `simplemd:worker-sem-dom: decode-named-character-reference resolveu para "${id}", sem ${DOM_VARIANT} nem ${WORKER_VARIANT}; revise o plugin (CR-S5-09).`,
      );
    },
  };
}
