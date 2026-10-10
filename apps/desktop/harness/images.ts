import { VaultError, imageMaxBytes, type ImageKind, type VaultErrorCode } from '@simplemd/vault';

/**
 * Leitura de imagens do harness (r7 arch-backend §1.3; AC-I1.6…I1.11 na QA): envolve o
 * `readImage` da porta em memória com um contador por caminho (o que chegou à porta; o que a guarda
 * do provider recusa antes não aparece) e injeção de falha. As tabelas de tipo e de teto são as do
 * `LocalFsProvider`, as mesmas da produção. Só neste bundle (`assert-no-harness`).
 */
export const FAKE_IMAGES_MARKER = 'simplemd:fake-images';

const MAGIC: Readonly<Record<ImageKind, readonly number[]>> = {
  png: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  jpeg: [0xff, 0xd8, 0xff, 0xe0],
  gif: [...'GIF89a'].map((c) => c.charCodeAt(0)),
  webp: [...'RIFF\0\0\0\0WEBP'].map((c) => c.charCodeAt(0)),
  svg: [...'<svg xmlns="http://www.w3.org/2000/svg">'].map((c) => c.charCodeAt(0)),
};

/**
 * Bytes válidos do tipo `kind` com exatamente `teto + extra` bytes (padrão: teto + 1, o caso de
 * recusa de NFR-45). Gerado em tempo de teste: o arquivo de 20 MiB + 1 nunca é versionado.
 */
export function imageOfSize(kind: ImageKind, extra = 1): Uint8Array {
  const bytes = new Uint8Array(imageMaxBytes(kind) + extra).fill(kind === 'svg' ? 0x20 : 0);
  bytes.set(MAGIC[kind]);
  return bytes;
}

export interface HarnessImagesControl {
  readonly marker: string;
  /** Leituras de imagem que chegaram à porta, por caminho relativo ao vault. */
  calls(): Readonly<Record<string, number>>;
  /** A próxima leitura (de `path`, se dado) falha com `code`. */
  failNext(op: 'readImage', code: VaultErrorCode, path?: string): void;
  reset(): void;
}

export function createHarnessImages(): {
  /** Conta, aplica a falha injetada e delega a `read`. */
  read(rel: string, read: () => Promise<Uint8Array>): Promise<Uint8Array>;
  control: HarnessImagesControl;
} {
  const counts = new Map<string, number>();
  let faults: Array<{ code: VaultErrorCode; path?: string }> = [];
  return {
    async read(rel, read) {
      counts.set(rel, (counts.get(rel) ?? 0) + 1);
      const fault = faults.find((f) => f.path === undefined || f.path === rel);
      if (fault) {
        faults = faults.filter((f) => f !== fault);
        throw new VaultError(fault.code, `Falha injetada (${fault.code}).`, { path: rel });
      }
      return read();
    },
    control: {
      marker: FAKE_IMAGES_MARKER,
      calls: () => Object.fromEntries(counts),
      failNext(_op, code, path) {
        faults.push(path === undefined ? { code } : { code, path });
      },
      reset() {
        counts.clear();
        faults = [];
      },
    },
  };
}
