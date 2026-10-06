import { afterEach, describe, expect, test } from 'vitest';
import { decodeDocument, encodeDocument } from '../src/index';
import { makeTempVault, type TempVault } from './helpers/tmp';

describe('codec de EOL/BOM', () => {
  test('CRLF + BOM: o documento do editor só tem \\n e a ida e volta é exata', () => {
    const raw = '\uFEFF# T\r\n\r\ntexto\r\n';
    const { doc, format } = decodeDocument(raw);
    expect(doc).toBe('# T\n\ntexto\n');
    expect(format).toEqual({ eol: '\r\n', bom: true, mixed: false });
    expect(encodeDocument(doc, format)).toBe(raw);
  });

  test('LF sem BOM, arquivo sem quebras e CR isolado', () => {
    expect(decodeDocument('a\nb\n').format).toEqual({ eol: '\n', bom: false, mixed: false });
    expect(decodeDocument('sem quebra').format).toEqual({ eol: '\n', bom: false, mixed: false });
    expect(decodeDocument('a\rb').doc).toBe('a\nb');
  });

  test('misto: normaliza para o estilo dominante e sinaliza mixed', () => {
    const { doc, format } = decodeDocument('a\r\nb\r\nc\nd');
    expect(format).toEqual({ eol: '\r\n', bom: false, mixed: true });
    expect(encodeDocument(doc, format)).toBe('a\r\nb\r\nc\r\nd');
    expect(decodeDocument('a\nb\nc\r\n').format.eol).toBe('\n');
  });
});

describe('AC-2.8: inserir 1 caractere e salvar preserva CRLF e BOM (arquivo real)', () => {
  let vault: TempVault | undefined;
  afterEach(() => {
    vault?.cleanup();
    vault = undefined;
  });

  // As fixtures são geradas em tempo de execução, para o checkout do Windows nunca reescrever bytes.
  const cases = [
    { name: 'CRLF + BOM', raw: '\uFEFF# Título\r\n\r\nParágrafo um.\r\nLinha dois.\r\n' },
    { name: 'LF', raw: '# Título\n\nParágrafo um.\nLinha dois.\n' },
  ];

  test.each(cases)('$name', async ({ raw }) => {
    vault = await makeTempVault({ 'nota.md': raw });
    const original = vault.bytes('nota.md');
    const { text, mtime } = await vault.provider.read(vault.handle, 'nota.md');
    const { doc, format } = decodeDocument(text);
    const at = doc.indexOf('um.') + 2;
    const edited = `${doc.slice(0, at)}X${doc.slice(at)}`;
    await vault.provider.write(vault.handle, 'nota.md', encodeDocument(edited, format), mtime);

    const saved = vault.bytes('nota.md');
    const insertedAt = original.indexOf(Buffer.from('um.')) + 2;
    expect(saved.length).toBe(original.length + 1);
    expect(saved.subarray(0, insertedAt)).toEqual(original.subarray(0, insertedAt));
    expect(String.fromCharCode(saved[insertedAt] ?? 0)).toBe('X');
    expect(saved.subarray(insertedAt + 1)).toEqual(original.subarray(insertedAt));
    const crlf = (b: Buffer) => b.toString('latin1').split('\r\n').length - 1;
    expect(crlf(saved)).toBe(crlf(original));
    expect(saved.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))).toBe(
      raw.startsWith('\uFEFF'),
    );
  });
});
