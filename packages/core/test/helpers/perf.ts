/**
 * Portão das asserções de tempo de relógio (TA-R2-16, TA-R2-19, R5-02). Elas só valem na máquina
 * de referência sem carga e falham em suítes embaralhadas ou em runners lentos, então não rodam na
 * suíte padrão nem no CI. Para medir: `SIMPLEMD_PERF=1 pnpm exec vitest run --project core`.
 * As propriedades que elas acompanham têm testes determinísticos (trabalho de parse, limite de
 * aliases) que rodam sempre.
 */
function perfFlag(): boolean {
  // O pacote core não carrega os tipos do Node; o processo do Vitest existe em tempo de execução.
  const proc: unknown = Reflect.get(globalThis, 'process');
  if (typeof proc !== 'object' || proc === null || !('env' in proc)) return false;
  const env: unknown = proc.env;
  return typeof env === 'object' && env !== null && Reflect.get(env, 'SIMPLEMD_PERF') === '1';
}

export const PERF_GATE = perfFlag();
