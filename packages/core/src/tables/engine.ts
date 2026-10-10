import type * as Engine from '@tgrosinger/md-advanced-tables';

/**
 * Motor de tabelas `@tgrosinger/md-advanced-tables` 3.11.0 (MIT) num pedaço sob demanda
 * (`tables-engine`, arch-frontend r7 §7, D-R7-F07). Este é o ÚNICO `import()` do pacote (regra do
 * ESLint do S0); o resto do núcleo só importa tipos. A carga começa na primeira tabela de topo vista
 * ou quando o cursor entra numa (`prefetchTableEngine`, `tables/keys.ts`).
 */
export type TableEngine = typeof Engine;
export type TableOptions = Engine.Options;

let loaded: TableEngine | null = null;
let loading: Promise<TableEngine> | null = null;
let options: { readonly normal: TableOptions; readonly sameColumn: TableOptions } | null = null;

/** O motor já carregado (síncrono), ou `null` enquanto o pedaço não chegou. */
export function tableEngine(): TableEngine | null {
  return loaded;
}

/** Carrega o motor uma vez; falha de rede/pedaço → a próxima chamada tenta de novo. */
export function loadTableEngine(): Promise<TableEngine> {
  loading ??= import('@tgrosinger/md-advanced-tables').then(
    (mod) => {
      // CommonJS: o Node expõe os nomes no namespace; um bundler pode deixá-los só em `default`.
      const interop: unknown = Reflect.get(mod, 'default');
      // Mesmo módulo, só reembrulhado pelo interop (não é entrada externa).
      const lib = 'TableEditor' in mod ? mod : (interop as TableEngine);
      loaded = lib;
      return lib;
    },
    (error: unknown) => {
      loading = null;
      throw error;
    },
  );
  return loading;
}

/** Pré-carga sem esperar (o erro reaparece, e é tratado, na carga de um comando). */
export function prefetchTableEngine(): void {
  if (loaded) return;
  loadTableEngine().catch(() => {});
}

/**
 * Opções do formatador (Q-R7-F05): `FormatType.NORMAL`, normalização Unicode e largura East Asian
 * do `meaw` (CJK e emoji = 2 colunas; ambíguos = 1). `sameColumn` liga o "cursor esperto" do
 * upstream só para "Próxima linha" (Enter mantém a coluna, D-43).
 */
export function tableOptions(engine: TableEngine): {
  readonly normal: TableOptions;
  readonly sameColumn: TableOptions;
} {
  if (options) return options;
  const normal = engine.optionsWithDefaults({
    formatType: engine.FormatType.NORMAL,
    textWidthOptions: {
      normalize: true,
      wideChars: new Set(),
      narrowChars: new Set(),
      ambiguousAsWide: false,
    },
  });
  options = { normal, sameColumn: { ...normal, smartCursor: true } };
  return options;
}
