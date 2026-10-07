import { parse, type ImportSpecifier } from 'es-module-lexer/js';

/**
 * Carregamento de código externo (arch-frontend r2 §2.3, arch-backend r2 §1.3.3). O hash aprovado
 * é o sha256 dos bytes do arquivo, lidos UMA vez; o texto executado é T(bytes), uma transformação
 * determinística e em memória sobre o MESMO buffer (sem segunda leitura, logo sem TOCTOU):
 * (a) os 4 especificadores dos módulos do host viram URLs de módulos-ponte;
 * (b) um `//# sourceURL=simplemd-plugin://<id>/<main>` é acrescentado para atribuir falhas;
 * (c) qualquer outro especificador falha a ativação nomeando-o (v1 = um único `main.js`).
 */
export const HOST_MODULES = [
  '@codemirror/state',
  '@codemirror/view',
  '@codemirror/language',
  '@codemirror/autocomplete',
] as const;
export type HostModuleName = (typeof HOST_MODULES)[number];
export type HostModules = Readonly<Record<HostModuleName, object>>;
export type HostModuleUrls = Readonly<Record<HostModuleName, string>>;

/** Chave do registro global dos módulos do host (só os 4 namespaces do CodeMirror). */
export const HOST_REGISTRY_KEY = Symbol.for('simplemd.hostModules');

export const PLUGIN_URL_SCHEME = 'simplemd-plugin://';

/** Falha ao preparar/importar o módulo; `specifier` = o import recusado (STR-65). */
export class PluginLoadError extends Error {
  readonly specifier: string | undefined;
  constructor(message: string, specifier?: string) {
    super(message);
    this.name = 'PluginLoadError';
    this.specifier = specifier;
  }
}

/**
 * Publica texto de módulo e o importa. Produção e harness: `blob:` (CSP `script-src 'self'
 * blob:`). Vitest: arquivos temporários (o Node não importa `blob:`).
 */
export interface ModuleEvaluator {
  publish(text: string): string;
  importModule(url: string): Promise<Record<string, unknown>>;
  /** Libera a URL de um módulo já avaliado (o módulo continua vivo). */
  release?(url: string): void;
}

const decoder = new TextDecoder('utf-8', { fatal: true });
const isHostModule = (name: string): name is HostModuleName =>
  (HOST_MODULES as readonly string[]).includes(name);

/** T(bytes): o texto que será executado (ver o comentário do módulo). */
export function prepareModule(
  bytes: Uint8Array,
  id: string,
  main: string,
  hostUrls: HostModuleUrls,
): string {
  let text: string;
  try {
    text = decoder.decode(bytes);
  } catch {
    throw new PluginLoadError('main.js não está em UTF-8.');
  }
  let imports: readonly ImportSpecifier[];
  try {
    [imports] = parse(text);
  } catch (error) {
    throw new PluginLoadError(
      `main.js não pôde ser lido como módulo: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let out = '';
  let last = 0;
  for (const entry of imports) {
    if (entry.d === -2) continue; // import.meta
    const name = entry.n;
    if (name === undefined || !isHostModule(name)) {
      const spec = name ?? text.slice(entry.s, entry.e);
      throw new PluginLoadError(`Importa um módulo indisponível: “${spec}”.`, spec);
    }
    // Import estático: `s..e` é o texto do especificador sem aspas; dinâmico: com as aspas.
    const dynamic = entry.d > -1;
    out += text.slice(last, entry.s) + (dynamic ? JSON.stringify(hostUrls[name]) : hostUrls[name]);
    last = entry.e;
  }
  return `${out}${text.slice(last)}\n//# sourceURL=${PLUGIN_URL_SCHEME}${id}/${main}\n`;
}

/** Texto do módulo-ponte que reexporta, de um namespace do app, cada nome exportado. */
export function hostShimSource(name: HostModuleName, namespace: object): string {
  const names = Object.keys(namespace).filter(
    (key) => key !== 'default' && /^[A-Za-z_$][\w$]*$/.test(key),
  );
  return (
    `const m = globalThis[Symbol.for('simplemd.hostModules')][${JSON.stringify(name)}];\n` +
    `export const { ${names.join(', ')} } = m;\n`
  );
}

let shimUrls: HostModuleUrls | null = null;

/**
 * Instala o registro global (propriedade não enumerável e congelada, só com os 4 namespaces do
 * CodeMirror; nada do Tauri) e publica os módulos-ponte uma vez por sessão. As mesmas instâncias do
 * app chegam ao plugin, então `instanceof` funciona (R-6.8).
 */
export function installHostModules(
  modules: HostModules,
  evaluator: ModuleEvaluator,
): HostModuleUrls {
  if (shimUrls) return shimUrls;
  const registry = globalThis as Record<symbol, unknown>;
  if (!(HOST_REGISTRY_KEY in registry)) {
    Object.defineProperty(globalThis, HOST_REGISTRY_KEY, {
      value: Object.freeze({ ...modules }),
      enumerable: false,
      writable: false,
      configurable: false,
    });
  }
  const urls = {} as Record<HostModuleName, string>;
  for (const name of HOST_MODULES)
    urls[name] = evaluator.publish(hostShimSource(name, modules[name]));
  shimUrls = Object.freeze(urls);
  return shimUrls;
}
