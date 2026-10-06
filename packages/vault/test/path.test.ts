import { describe, expect, it } from 'vitest';
import { VaultError, type VaultErrorCode } from '../src/errors';
import { toVaultPath } from '../src/path';

function codeOf(input: string): VaultErrorCode | 'OK' {
  try {
    toVaultPath(input);
    return 'OK';
  } catch (error) {
    if (error instanceof VaultError) return error.code;
    throw error;
  }
}

describe('toVaultPath (arch-backend §1.5.3)', () => {
  it.each([
    ['nota.md', 'nota.md'],
    ['sub/c.md', 'sub/c.md'],
    ['a/b/c/d.md', 'a/b/c/d.md'],
    ['.simplemd/config.json', '.simplemd/config.json'],
    ['.simplemd/themes/meu-tema/theme.json', '.simplemd/themes/meu-tema/theme.json'],
    ['Notas com espaço/Olá mundo.md', 'Notas com espaço/Olá mundo.md'],
    ['console.md', 'console.md'],
    ['a..b.md', 'a..b.md'],
  ])('aceita %j', (input, expected) => {
    expect(toVaultPath(input)).toBe(expected);
  });

  it.each<[string, VaultErrorCode]>([
    // 1. tamanho e caracteres de controle
    ['', 'INVALID_PATH'],
    ['a'.repeat(1025), 'INVALID_PATH'],
    ['a\u0000.md', 'INVALID_PATH'],
    ['a\n.md', 'INVALID_PATH'],
    ['a\u007f.md', 'INVALID_PATH'],
    // 2. barra invertida (separador do Windows) nunca é aceita
    ['a\\..\\x.md', 'INVALID_PATH'],
    ['sub\\c.md', 'INVALID_PATH'],
    // 3. absoluto ou enraizado
    ['/etc/x.md', 'OUTSIDE_VAULT'],
    ['//servidor/x.md', 'OUTSIDE_VAULT'],
    ['~/x.md', 'OUTSIDE_VAULT'],
    ['C:/x.md', 'OUTSIDE_VAULT'],
    ['c:x.md', 'OUTSIDE_VAULT'],
    // 4. `..` sai do vault; segmento vazio ou `.` é inválido
    ['../x.md', 'OUTSIDE_VAULT'],
    ['sub/../../x.md', 'OUTSIDE_VAULT'],
    ['sub/..', 'OUTSIDE_VAULT'],
    ['./x.md', 'INVALID_PATH'],
    ['a//b.md', 'INVALID_PATH'],
    ['sub/', 'INVALID_PATH'],
    // 5. segmentos ocultos (exceto `.simplemd` no início)
    ['.git/config', 'INVALID_PATH'],
    ['.hidden.md', 'INVALID_PATH'],
    ['sub/.simplemd/config.json', 'INVALID_PATH'],
    ['.simplemdx/config.json', 'INVALID_PATH'],
    // 6. fluxo alternativo do NTFS
    ['a.md:s', 'INVALID_PATH'],
    // 7. termina em espaço ou ponto
    ['a.md.', 'INVALID_PATH'],
    ['pasta /a.md', 'INVALID_PATH'],
    // 8. nomes reservados do Windows
    ['con', 'INVALID_PATH'],
    ['sub/NUL.md', 'INVALID_PATH'],
    ['com1.txt', 'INVALID_PATH'],
    ['LPT9', 'INVALID_PATH'],
  ])('rejeita %j com %s', (input, code) => {
    expect(codeOf(input)).toBe(code);
  });

  it('anexa o caminho recebido ao erro', () => {
    try {
      toVaultPath('../segredo.md');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(VaultError);
      expect((error as VaultError).path).toBe('../segredo.md');
    }
  });
});
