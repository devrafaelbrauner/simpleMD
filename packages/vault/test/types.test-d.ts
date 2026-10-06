import { describe, expectTypeOf, test } from 'vitest';
import type { Entry, Unsubscribe, VaultHandle, VaultProvider, VaultWatchEvent } from '../src/index';
import { LocalFsProvider } from '../src/index';

/** PLANO §4.3, com os tipos de parâmetro que o arch-backend §1.5.1 fixou. */
interface PlanoVaultProvider {
  open(): Promise<VaultHandle>;
  list(handle: VaultHandle, dir?: string): Promise<Entry[]>;
  read(handle: VaultHandle, path: string): Promise<{ text: string; mtime: number }>;
  write(
    handle: VaultHandle,
    path: string,
    text: string,
    expectedMtime?: number,
  ): Promise<{ mtime: number }>;
  watch?(handle: VaultHandle, cb: (event: VaultWatchEvent) => void): Unsubscribe;
}

describe('AC-2.1: VaultProvider tem exatamente a forma de PLANO §4.3', () => {
  test('a interface exportada é igual à de §4.3', () => {
    expectTypeOf<VaultProvider>().toEqualTypeOf<PlanoVaultProvider>();
    expectTypeOf<keyof VaultProvider>().toEqualTypeOf<
      'open' | 'list' | 'read' | 'write' | 'watch'
    >();
  });

  test('LocalFsProvider satisfaz VaultProvider', () => {
    expectTypeOf<LocalFsProvider>().toExtend<VaultProvider>();
    expectTypeOf<LocalFsProvider['write']>().parameters.toEqualTypeOf<
      [VaultHandle, string, string, (number | undefined)?]
    >();
  });
});
