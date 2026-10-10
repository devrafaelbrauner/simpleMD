// r7 arch-backend §1.3 / §5.2–§5.3: tipos de imagem do vault. A tabela de paridade
// `fixtures/image-magic-cases.json` é a MESMA lida pelo teste Rust (`vault::image`): extensão +
// bytes mágicos → aceito ou `UNSUPPORTED_IMAGE`, nos dois lados.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  IMAGE_MAX_BYTES,
  IMAGE_MIME,
  imageKindOf,
  imageMaxBytes,
  sniffImage,
  type ImageKind,
} from '../src/index';

interface Case {
  readonly name: string;
  readonly hex?: string;
  readonly text?: string;
  readonly expect: 'ok' | 'UNSUPPORTED_IMAGE';
}

const CASES = JSON.parse(
  readFileSync(join(__dirname, 'fixtures/image-magic-cases.json'), 'utf8'),
) as Case[];

function bytesOf(c: Case): Uint8Array {
  if (c.hex !== undefined) return Uint8Array.from(c.hex.match(/../g) ?? [], (h) => parseInt(h, 16));
  return new TextEncoder().encode(c.text ?? '');
}

const ascii = (text: string) => Uint8Array.from(text, (c) => c.charCodeAt(0));

describe('image-type: paridade com o Rust (image-magic-cases.json)', () => {
  test('a tabela tem ≥ 25 casos', () => {
    expect(CASES.length).toBeGreaterThanOrEqual(25);
  });

  test.each(CASES)('$name → $expect', (c) => {
    const kind = imageKindOf(c.name);
    const got = kind !== null && sniffImage(kind, bytesOf(c)) ? 'ok' : 'UNSUPPORTED_IMAGE';
    expect(got).toBe(c.expect);
  });
});

describe('image-type: regras', () => {
  test('extensão (sem caixa, último segmento) → tipo; resto → null', () => {
    const table: Array<[string, ImageKind | null]> = [
      ['a.png', 'png'],
      ['pasta/B.PNG', 'png'],
      ['x.jpg', 'jpeg'],
      ['x.JPEG', 'jpeg'],
      ['x.gif', 'gif'],
      ['x.webp', 'webp'],
      ['x.Svg', 'svg'],
      ['x.svgz', null],
      ['x.bmp', null],
      ['.png', null],
      ['png', null],
      ['pasta.png/arquivo', null],
      ['nota.md', null],
      ['x.constructor', null],
      ['x.__proto__', null],
      ['x.toString', null],
    ];
    for (const [path, kind] of table) expect(imageKindOf(path), path).toBe(kind);
  });

  test('MIME e tetos (NFR-45: raster 20 MiB, SVG 2 MiB)', () => {
    expect(IMAGE_MIME).toEqual({
      png: 'image/png',
      jpeg: 'image/jpeg',
      gif: 'image/gif',
      webp: 'image/webp',
      svg: 'image/svg+xml',
    });
    expect(IMAGE_MAX_BYTES).toEqual({ raster: 20 * 1024 * 1024, svg: 2 * 1024 * 1024 });
    expect(imageMaxBytes('png')).toBe(20 * 1024 * 1024);
    expect(imageMaxBytes('svg')).toBe(2 * 1024 * 1024);
  });

  test('SVG: <svg só conta nos primeiros 4.096 bytes; BOM e espaços antes do <', () => {
    const late = new Uint8Array(4096 + 6).fill(0x20);
    late.set(ascii('<?xml version="1.0"?>'));
    late.set(ascii('<svg/>'), 4096);
    expect(sniffImage('svg', late)).toBe(false);
    const edge = new Uint8Array(4096).fill(0x20);
    edge.set(ascii('<?xml?>'));
    edge.set(ascii('<svg/>'), 4096 - 6);
    expect(sniffImage('svg', edge)).toBe(true);
    expect(sniffImage('svg', ascii('\uFEFF<svg/>'))).toBe(false); // BOM como 1 byte latin1 ≠ UTF-8
    expect(sniffImage('svg', Uint8Array.of(0xef, 0xbb, 0xbf, ...ascii(' \f<svg/>')))).toBe(true);
    expect(sniffImage('svg', new Uint8Array())).toBe(false);
    expect(sniffImage('svg', ascii('<!DOCTYPE HTML><svg/>'))).toBe(false);
  });

  test('raster: prefixos curtos e vazios são recusados', () => {
    for (const kind of ['png', 'jpeg', 'gif', 'webp'] as const)
      expect(sniffImage(kind, new Uint8Array()), kind).toBe(false);
    expect(sniffImage('webp', ascii('RIFF0000WEB'))).toBe(false);
    expect(sniffImage('webp', ascii('RIFF0000WEBP'))).toBe(true);
  });
});
