import type { QuerySnapshotRenderer } from '@simplemd/plugins-internal/tasks/render';

/**
 * Instantâneo das consultas na exportação (AC-EX.4; arch-frontend r7 §9). Só o registro do
 * `simplemd.tasks` (`plugins/internal/tasks.ts`, dono do catálogo privado por closure) põe aqui o
 * renderizador ao carregar o plugin; a exportação o usa só com o plugin ligado (`INTERNAL_IDS`).
 * Nada do catálogo passa por este módulo: só a função que devolve o HTML do instantâneo.
 */
let current: QuerySnapshotRenderer | null = null;

export function setQuerySnapshotRenderer(renderer: QuerySnapshotRenderer | null): void {
  current = renderer;
}

export function querySnapshotRenderer(): QuerySnapshotRenderer | null {
  return current;
}
