/**
 * Contadores de trabalho do live preview (arch-frontend r7 §5.2, NFR-41/43), lidos pelo harness em
 * `renderCounts()`: quantas vezes um contribuidor de bloco montou um widget e quantas leituras de
 * imagem o widget pediu ao serviço. Só somam; nunca mudam comportamento.
 */
export const liveCounters = {
  blockBuilds: 0,
  imageLoads: 0,
  /** r7 S10: faltas da cache de sanitização do editor (`sanitize/cache.ts`; NFR-41 "0 re-sanitizações"). */
  sanitizeRuns: 0,
};
