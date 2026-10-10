// r7 SN (arch-backend §1.2–§1.4, arch-frontend §13): os falsos nativos do harness seguem o
// contrato dos comandos Rust — "abrir URL" registra sem abrir (validação injetada, D-R7-SN-01),
// imagens contam por caminho com falha injetada, e o LanguageTool falso respeita "último vence",
// tempos-limite e códigos do Rust, sem guardar o texto. Corpos sintéticos inline (C-2).
import { IMAGE_MAX_BYTES, LocalFsProvider, sniffImage } from '@simplemd/vault';
import { MemoryFsPort } from '@simplemd/vault/testing';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createHarnessImages, imageOfSize } from '../harness/images';
import { createHarnessLanguageTool, LT_FAKE_LIMITS } from '../harness/languagetool';
import { createHarnessOpener } from '../harness/opener';

const req = { language: 'pt-BR', annotation: [{ text: 'Isso é uma excessão SEGREDO.' }] };
const rejection = (p: Promise<unknown>) =>
  p.then(
    () => 'OK',
    (e: { code?: string; detail?: unknown }) => e,
  );

describe('opener falso', () => {
  test('sem validação registra e aceita; fail simula a recusa do Rust', async () => {
    let t = 100;
    const { openUrl, control } = createHarnessOpener(() => t++);
    await openUrl('https://exemplo.org/a?b=1#c');
    control.fail = 'RATE_LIMITED';
    await expect(openUrl('https://exemplo.org/')).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    expect(control.calls()).toEqual([
      { url: 'https://exemplo.org/a?b=1#c', ts: 100, accepted: true, code: null },
      { url: 'https://exemplo.org/', ts: 101, accepted: false, code: 'RATE_LIMITED' },
    ]);
    expect(control.accepted()).toHaveLength(1);
    control.reset();
    expect([control.calls(), control.fail]).toEqual([[], null]);
  });

  test('validação registrada depois (uma linha do S1, F-11): recusa = 0 aceitas', async () => {
    const { openUrl, control } = createHarnessOpener();
    expect(control.validate).toBeNull();
    control.validate = (url) => (url.startsWith('javascript:') ? 'URL_SCHEME_NOT_ALLOWED' : null);
    await expect(openUrl('javascript:alert(1)')).rejects.toMatchObject({
      code: 'URL_SCHEME_NOT_ALLOWED',
    });
    await openUrl('mailto:a@b.c');
    expect(control.accepted().map((c) => c.url)).toEqual(['mailto:a@b.c']);
    control.reset();
    expect(control.validate).not.toBeNull();
  });
});

describe('imagens falsas', () => {
  test('contagem por caminho, falha injetada uma vez e só no caminho pedido', async () => {
    const { read, control } = createHarnessImages();
    const bytes = Uint8Array.of(1);
    await read('a.png', async () => bytes);
    control.failNext('readImage', 'IO', 'b.png');
    await read('a.png', async () => bytes);
    await expect(read('b.png', async () => bytes)).rejects.toMatchObject({ code: 'IO' });
    await read('b.png', async () => bytes);
    expect(control.calls()).toEqual({ 'a.png': 2, 'b.png': 2 });
    control.reset();
    expect(control.calls()).toEqual({});
  });

  test('imageOfSize gera teto + 1 válido para o tipo (20 MiB + 1 e SVG 2 MiB + 1)', async () => {
    const png = imageOfSize('png');
    const svg = imageOfSize('svg');
    expect(png.length).toBe(IMAGE_MAX_BYTES.raster + 1);
    expect(svg.length).toBe(IMAGE_MAX_BYTES.svg + 1);
    for (const kind of ['png', 'jpeg', 'gif', 'webp', 'svg'] as const)
      expect(sniffImage(kind, imageOfSize(kind, -1)), kind).toBe(true);
    const port = new MemoryFsPort();
    port.seed({ 'g.png': png, 'ok.png': imageOfSize('png', 0) });
    const provider = new LocalFsProvider(port);
    const handle = await provider.open();
    await expect(provider.readImage(handle, 'g.png')).rejects.toMatchObject({ code: 'TOO_LARGE' });
    expect((await provider.readImage(handle, 'ok.png')).size).toBe(IMAGE_MAX_BYTES.raster);
  });
});

describe('LanguageTool falso', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test('padrão: CONNECTION_REFUSED (sem servidor), como o Rust nos 2 endereços', async () => {
    const { languageTool, control } = createHarnessLanguageTool();
    const pending = rejection(languageTool.languages());
    await vi.advanceTimersByTimeAsync(0);
    expect(await pending).toMatchObject({ code: 'CONNECTION_REFUSED' });
    expect(control.calls().map((c) => c.outcome)).toEqual(['CONNECTION_REFUSED']);
  });

  test('corpo sintético inline; calls() só com língua e contagens, nunca o texto', async () => {
    const { languageTool, control } = createHarnessLanguageTool();
    control.mode = { kind: 'body', body: '{"matches":[{"offset":11,"length":8}]}' };
    const pending = languageTool.check(req, 1);
    await vi.advanceTimersByTimeAsync(0);
    expect(await pending).toBe('{"matches":[{"offset":11,"length":8}]}');
    const [call] = control.calls();
    expect(call).toMatchObject({
      op: 'check',
      requestId: 1,
      language: 'pt-BR',
      segments: 1,
      units: 28,
    });
    expect(JSON.stringify(control.calls())).not.toContain('SEGREDO');
  });

  test('http(status), oversize e badUtf8 → códigos do Rust', async () => {
    const { languageTool, control } = createHarnessLanguageTool();
    const table = [
      [
        { kind: 'http', status: 500 },
        { code: 'LT_HTTP_STATUS', detail: { status: 500 } },
      ],
      [{ kind: 'oversize' }, { code: 'RESPONSE_TOO_LARGE' }],
      [{ kind: 'badUtf8' }, { code: 'BAD_UTF8' }],
    ] as const;
    for (const [mode, expected] of table) {
      control.mode = mode;
      const pending = rejection(languageTool.check(req, 2));
      await vi.advanceTimersByTimeAsync(0);
      expect(await pending).toMatchObject(expected);
    }
  });

  test('slow: só o tempo-limite encerra (check 15 s, sonda 2 s) → TIMEOUT com seconds', async () => {
    const { languageTool, control } = createHarnessLanguageTool();
    control.mode = { kind: 'slow' };
    const check = rejection(languageTool.check(req, 3));
    const probe = rejection(languageTool.languages());
    await vi.advanceTimersByTimeAsync(LT_FAKE_LIMITS.probeMs);
    expect(await probe).toMatchObject({ code: 'TIMEOUT', detail: { seconds: 2 } });
    await vi.advanceTimersByTimeAsync(LT_FAKE_LIMITS.checkMs - LT_FAKE_LIMITS.probeMs);
    expect(await check).toMatchObject({ code: 'TIMEOUT', detail: { seconds: 15 } });
  });

  test('delay(ms): responde depois do atraso; acima do limite vira TIMEOUT', async () => {
    const { languageTool, control } = createHarnessLanguageTool();
    control.mode = { kind: 'delay', ms: 1_000 };
    const ok = languageTool.check(req, 4);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await ok).toBe('{"matches":[]}');
    control.mode = { kind: 'delay', ms: 20_000 };
    const late = rejection(languageTool.check(req, 5));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await late).toMatchObject({ code: 'TIMEOUT' });
  });

  test('último vence: um check novo cancela o anterior; cancel só com o id certo', async () => {
    const { languageTool, control } = createHarnessLanguageTool();
    control.mode = { kind: 'delay', ms: 500, body: '{"matches":[]}' };
    const first = rejection(languageTool.check(req, 1));
    const second = languageTool.check(req, 2);
    await vi.advanceTimersByTimeAsync(500);
    expect(await first).toMatchObject({ code: 'CANCELLED' });
    expect(await second).toBe('{"matches":[]}');
    const third = rejection(languageTool.check(req, 3));
    await languageTool.cancel(99);
    await languageTool.cancel(3);
    expect(await third).toMatchObject({ code: 'CANCELLED' });
  });

  test('recorded sem o arquivo gravado (diretório de S8 vazio) cai no corpo vazio', async () => {
    const { languageTool, control } = createHarnessLanguageTool();
    control.mode = { kind: 'recorded', name: 'pt-BR-check' };
    const languages = languageTool.languages();
    const check = languageTool.check(req, 6);
    await vi.advanceTimersByTimeAsync(0);
    expect(JSON.parse(await languages)).toEqual(
      expect.arrayContaining([expect.objectContaining({ longCode: 'pt-BR' })]),
    );
    expect(await check).toEqual(
      control.recorded().includes('pt-BR-check') ? expect.any(String) : '{"matches":[]}',
    );
  });

  test('pedido vazio ou > 20.000 unidades → LT_INVALID_REQUEST sem resposta', async () => {
    const { languageTool, control } = createHarnessLanguageTool();
    control.mode = { kind: 'body', body: '{}' };
    expect(
      await rejection(languageTool.check({ language: 'pt-BR', annotation: [] }, 1)),
    ).toMatchObject({ code: 'LT_INVALID_REQUEST' });
    const big = { language: 'pt-BR', annotation: [{ markup: 'x'.repeat(20_001) }] };
    expect(await rejection(languageTool.check(big, 2))).toMatchObject({
      code: 'LT_INVALID_REQUEST',
    });
  });
});
