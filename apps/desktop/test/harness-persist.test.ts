// r41i: o `&persist=1` do harness (`harness/persist.ts`, ligado em `harness/main.tsx`). RC-R32B-E2:
// trocar de pasta pela URL depois de `persist=1` abre a pasta pedida, mesmo com o `pagehide` da
// página anterior regravando a dela. R32A-DETALHES: o que passa do teto ou da cota não é guardado
// (a chave sai, nada velho volta) e a carga seguinte o relata uma vez.
import { MemoryFsPort } from '@simplemd/vault/testing';
import { describe, expect, test } from 'vitest';
import { PRESETS } from '../harness/fixtures';
import {
  PERSIST_MAX_CHARS,
  PERSIST_SKIPPED_KEY,
  persistItem,
  takeSkipped,
  vaultStart,
  type PersistStorage,
} from '../harness/persist';

const VAULT_KEY = 'simplemd:harness-vault';

/** `sessionStorage` com cota em caracteres (as chaves juntas, como no navegador). */
function storage(quota = Number.POSITIVE_INFINITY): PersistStorage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  const used = () => [...map].reduce((sum, [key, value]) => sum + key.length + value.length, 0);
  return {
    map,
    getItem: (key) => map.get(key) ?? null,
    setItem(key, value) {
      const others = used() - (map.has(key) ? key.length + (map.get(key)?.length ?? 0) : 0);
      if (others + key.length + value.length > quota)
        throw new DOMException('cota excedida', 'QuotaExceededError');
      map.set(key, value);
    },
    removeItem: (key) => void map.delete(key),
  };
}

/** Uma página do harness: começa pela URL e, no `pagehide`, guarda a pasta como `main.tsx`. */
function page(store: PersistStorage, preset: 'FX-SMALL' | 'FX-EMPTY' | null) {
  const port = new MemoryFsPort();
  const plan = vaultStart(store.getItem(VAULT_KEY), preset);
  if (plan.kind === 'restore') port.restore(plan.snapshot);
  else if (plan.kind === 'seed') port.seed(PRESETS[plan.preset]());
  const from = plan.kind === 'restore' ? plan.from : preset;
  return {
    port,
    plan: plan.kind,
    files: () =>
      port
        .snapshot()
        .files.map(([path]) => path)
        .sort(),
    pagehide: () => persistItem(store, VAULT_KEY, { from, snapshot: port.snapshot() }),
  };
}

describe('RC-R32B-E2: a pasta pela URL depois de &persist=1', () => {
  test('outro ?vault= abre a pasta pedida, mesmo com o pagehide regravando a anterior', () => {
    const store = storage();
    const small = page(store, 'FX-SMALL');
    const smallFiles = small.files();
    expect(smallFiles).toContain('a.md');
    small.port.externalWrite('nova.md', '# Nova\n');
    expect(small.pagehide()).toBeNull();

    // Recarregar a mesma URL (e a sem ?vault=) devolve a pasta com a edição.
    const reloaded = page(store, 'FX-SMALL');
    expect([reloaded.plan, reloaded.files()]).toEqual([
      'restore',
      [...smallFiles, 'nova.md'].sort(),
    ]);
    reloaded.pagehide();
    expect(page(store, null).files()).toEqual([...smallFiles, 'nova.md'].sort());

    // O roteiro da evidência r32b: `removeItem` e `goto(?vault=FX-EMPTY&persist=1)`; o `pagehide`
    // da página que sai regrava a FX-SMALL antes de a nova ler.
    store.removeItem(VAULT_KEY);
    reloaded.pagehide();
    const empty = page(store, 'FX-EMPTY');
    expect(empty.plan).toBe('seed');
    expect(empty.files()).toEqual(Object.keys(PRESETS['FX-EMPTY']()).sort());
    // E a FX-EMPTY é a que volta na recarga dela.
    empty.port.externalWrite('vazia.md', 'x');
    empty.pagehide();
    expect(page(store, 'FX-EMPTY').files()).toContain('vazia.md');
  });

  test('valor ilegível ou do formato antigo conta como nada guardado', () => {
    for (const stored of ['{', 'null', '{"dirs":[],"files":[]}', '{"from":1,"snapshot":{}}']) {
      expect(vaultStart(stored, 'FX-SMALL')).toEqual({ kind: 'seed', preset: 'FX-SMALL' });
      expect(vaultStart(stored, null)).toEqual({ kind: 'none' });
    }
  });
});

describe('R32A-DETALHES: &persist=1 não estoura o sessionStorage', () => {
  test('acima do teto: a chave sai (nada velho volta) e a carga seguinte relata uma vez', () => {
    const store = storage();
    expect(persistItem(store, 'k', ['pequeno'])).toBeNull();
    expect(store.getItem('k')).toBe('["pequeno"]');
    const big = 'x'.repeat(PERSIST_MAX_CHARS);
    expect(persistItem(store, 'k', [big])).toEqual({
      key: 'k',
      chars: PERSIST_MAX_CHARS + 4,
      reason: 'cap',
    });
    expect(store.getItem('k')).toBeNull();
    expect(takeSkipped(store)).toEqual([{ key: 'k', chars: PERSIST_MAX_CHARS + 4, reason: 'cap' }]);
    expect(store.getItem(PERSIST_SKIPPED_KEY)).toBeNull();
    expect(takeSkipped(store)).toEqual([]);
  });

  test('recusado pela cota: não lança no pagehide, a chave velha sai e as duas chaves relatam', () => {
    const store = storage(1_000);
    expect(persistItem(store, 'vault', 'v'.repeat(400), 1_000)).toBeNull();
    expect(persistItem(store, 'dict', 'd'.repeat(400), 1_000)).toBeNull();
    // A pasta cresce: cabe no teto, mas não na cota com a outra chave.
    expect(persistItem(store, 'vault', 'v'.repeat(700), 1_000)).toMatchObject({
      key: 'vault',
      reason: 'quota',
    });
    expect(store.getItem('vault')).toBeNull();
    expect(persistItem(store, 'dict', 'd'.repeat(2_000), 1_000)).toMatchObject({
      key: 'dict',
      reason: 'cap',
    });
    expect(store.getItem('dict')).toBeNull();
    expect(takeSkipped(store).map((skip) => [skip.key, skip.reason])).toEqual([
      ['vault', 'quota'],
      ['dict', 'cap'],
    ]);
  });
});
