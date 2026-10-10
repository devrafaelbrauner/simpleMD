import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { Plugin } from 'vite';
import { describe, expect, it } from 'vitest';
import { DOM_VARIANT, WORKER_VARIANT, workerWithoutDom } from '../vite.worker-plugins';

/**
 * r7 S5 (D-R7-S5-05, CR-S5-09): o plugin dos bundles de worker troca a variante DOM de
 * `decode-named-character-reference` pela de worker. Os VT rodam sem `Worker`, então este teste
 * confere o pacote INSTALADO (o mesmo que o markdownlint → micromark importa): se um upgrade
 * renomear os arquivos ou o mapa `exports`, o teste quebra antes de o worker morrer em produção.
 */
const ROOT = join(__dirname, '../../..');

/** Pasta do pacote pela mesma cadeia do worker do lint: plugins-internal → markdownlint → micromark. */
function installedPackageDir(): string {
  let require = createRequire(join(ROOT, 'packages/plugins-internal/package.json'));
  for (const name of ['markdownlint', 'micromark']) require = createRequire(require.resolve(name));
  return dirname(require.resolve('decode-named-character-reference'));
}

type ResolveId = (
  this: { resolve: (source: string) => Promise<{ id: string } | null> },
  source: string,
  importer: string | undefined,
  options: object,
) => Promise<{ id: string } | null>;

function resolveWith(id: string | null, source = 'decode-named-character-reference') {
  const plugin: Plugin = workerWithoutDom();
  const resolveId = plugin.resolveId as unknown as ResolveId;
  return resolveId.call(
    { resolve: async () => (id === null ? null : { id }) },
    source,
    undefined,
    {},
  );
}

describe('plugin do worker sem DOM (vite.worker-plugins.ts, CR-S5-09)', () => {
  it('o pacote instalado tem os 2 arquivos e o mapa `exports` que o plugin pressupõe', () => {
    const dir = installedPackageDir();
    expect(existsSync(join(dir, DOM_VARIANT))).toBe(true);
    expect(existsSync(join(dir, WORKER_VARIANT))).toBe(true);
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
      exports: Record<string, string>;
    };
    expect(pkg.exports.browser).toBe(`./${DOM_VARIANT}`);
    expect(pkg.exports.worker).toBe(`./${WORKER_VARIANT}`);
    // A variante de worker não usa `document` (a razão de existir do plugin).
    expect(readFileSync(join(dir, WORKER_VARIANT), 'utf8')).not.toMatch(/\bdocument\b/);
    expect(readFileSync(join(dir, DOM_VARIANT), 'utf8')).toMatch(/\bdocument\b/);
  });

  it('a variante DOM resolvida vira a de worker (arquivo que existe no pacote instalado)', async () => {
    const dir = installedPackageDir().split('\\').join('/');
    const resolved = await resolveWith(`${dir}/${DOM_VARIANT}`);
    expect(resolved?.id).toBe(`${dir}/${WORKER_VARIANT}`);
    expect(existsSync(resolved?.id ?? '')).toBe(true);
    expect((await resolveWith(`${dir}/${WORKER_VARIANT}`))?.id).toBe(`${dir}/${WORKER_VARIANT}`);
  });

  it('nome inesperado ou pacote não resolvido: o build falha (nunca um worker que morre calado)', async () => {
    await expect(resolveWith('/x/decode-named-character-reference/browser.js')).rejects.toThrow(
      /CR-S5-09/,
    );
    await expect(resolveWith(null)).rejects.toThrow(/CR-S5-09/);
    expect(await resolveWith('/x/qualquer.js', 'outro-pacote')).toBeNull();
  });
});
