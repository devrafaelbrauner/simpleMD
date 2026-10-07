import type { AppPlatform } from '../src/platform/types';

/** Sentinela do armazém falso: `scripts/assert-no-harness.mjs` garante que nunca chega ao `dist`. */
export const FAKE_APPROVALS_MARKER = 'simplemd:fake-approvals';

export type MemoryApprovals = AppPlatform['approvals'] & {
  /** "Dispositivo novo": apaga todas as aprovações (H12). */
  reset(): void;
  /** Ids e estado ligado/desligado (sem hashes) — para "0 aprovações no vault" (H12). */
  list(): Array<{ id: string; enabled: boolean }>;
};

/**
 * Armazém de aprovações em memória (harness e Vitest), com a mesma semântica dos comandos Rust:
 * por dispositivo (fora do vault), `setEnabled` sem aprovação rejeita com `NOT_APPROVED`.
 */
export function createMemoryApprovals(): MemoryApprovals {
  const store = new Map<string, { sha256: string; enabled: boolean }>();
  return {
    async get() {
      return Object.fromEntries([...store].map(([id, a]) => [id, { ...a }]));
    },
    async set(id, sha256) {
      if (!/^[0-9a-f]{64}$/.test(sha256))
        throw Object.assign(new Error('INVALID_HASH'), { code: 'INVALID_HASH' });
      store.set(id, { sha256, enabled: true });
    },
    async setEnabled(id, enabled) {
      const approval = store.get(id);
      if (!approval) throw Object.assign(new Error('NOT_APPROVED'), { code: 'NOT_APPROVED' });
      approval.enabled = enabled;
    },
    async clear(id) {
      store.delete(id);
    },
    reset() {
      store.clear();
    },
    list: () => [...store].map(([id, a]) => ({ id, enabled: a.enabled })),
  };
}
