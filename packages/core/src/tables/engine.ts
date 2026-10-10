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
/** A última carga falhou: a pré-carga não tenta de novo; só um comando explícito tenta (CR-S3-07). */
let failed = false;
let options: { readonly normal: TableOptions; readonly sameColumn: TableOptions } | null = null;

/** O motor já carregado (síncrono), ou `null` enquanto o pedaço não chegou. */
export function tableEngine(): TableEngine | null {
  return loaded;
}

/** Carrega o motor uma vez; falha do pedaço → a próxima chamada (de um comando) tenta de novo. */
export function loadTableEngine(): Promise<TableEngine> {
  loading ??= import('@tgrosinger/md-advanced-tables').then(
    (mod) => {
      // CommonJS: o Node expõe os nomes no namespace; um bundler pode deixá-los só em `default`.
      const interop: unknown = Reflect.get(mod, 'default');
      // Mesmo módulo, só reembrulhado pelo interop (não é entrada externa).
      const lib = 'TableEditor' in mod ? mod : (interop as TableEngine);
      loaded = lib;
      failed = false;
      return lib;
    },
    (error: unknown) => {
      loading = null;
      failed = true;
      throw error;
    },
  );
  return loading;
}

/** Pré-carga já resolvida: o motor carregou, ou a última carga falhou (não tenta a cada tecla). */
export function tablePrefetchSettled(): boolean {
  return loaded !== null || failed;
}

/** Pré-carga sem esperar (o erro reaparece, e é tratado, na carga de um comando). */
export function prefetchTableEngine(): void {
  if (tablePrefetchSettled()) return;
  loadTableEngine().catch(() => {});
}

/**
 * Não-caracteres Unicode (U+FDD0–U+FDEF e U+nFFFE/U+nFFFF dos 17 planos: 66), reservados pela
 * norma para uso interno e nunca trocados em texto. O adaptador põe um deles no lugar de cada emoji
 * de vários pontos de código para o formatador contar 2 colunas (`wideChars`).
 */
export const CLUSTER_SLOTS: readonly string[] = [
  ...Array.from({ length: 32 }, (_, i) => String.fromCodePoint(0xfdd0 + i)),
  ...Array.from({ length: 17 }, (_, plane) => [
    String.fromCodePoint(plane * 0x10000 + 0xfffe),
    String.fromCodePoint(plane * 0x10000 + 0xffff),
  ]).flat(),
];

/**
 * Opções do formatador (Q-R7-F05): `FormatType.NORMAL`, normalização Unicode e largura East Asian
 * do `meaw` (CJK e emoji = 2 colunas; ambíguos = 1; emoji de vários pontos de código = 2 pelos
 * `CLUSTER_SLOTS`). `sameColumn` liga o "cursor esperto" do upstream só para "Próxima linha"
 * (Enter mantém a coluna, D-43).
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
      wideChars: new Set(CLUSTER_SLOTS),
      narrowChars: new Set(),
      ambiguousAsWide: false,
    },
  });
  options = { normal, sameColumn: { ...normal, smartCursor: true } };
  return options;
}
