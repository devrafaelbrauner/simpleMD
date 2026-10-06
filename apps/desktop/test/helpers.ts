import { LocalFsProvider, type FsPort } from '@simplemd/vault';
import { MemoryFsPort } from '@simplemd/vault/testing';
import { vi, type Mock } from 'vitest';
import { createAppController, type AppController } from '../src/app/controller';
import type { AppPlatform } from '../src/platform/types';

export interface Harness {
  readonly app: AppController;
  readonly port: MemoryFsPort;
  readonly platform: AppPlatform & { closeWindow: Mock<() => Promise<void>> };
  /** Escritas que chegaram à porta (inclusive as que falharam por injeção). */
  writes(): number;
  /** Simula a digitação do usuário no fim do documento da aba. */
  type(id: string, text: string): void;
  text(id: string): string | undefined;
  /** Deixa a fila de promessas andar sem avançar o relógio falso. */
  settle(): Promise<void>;
  requestClose(): Promise<boolean>;
}

/** Porta sem `watch`: o app cai na sondagem de 1.000 ms (NFR-12). */
function withoutWatch(port: MemoryFsPort): FsPort {
  return {
    pickDirectory: () => port.pickDirectory(),
    join: (root, rel) => port.join(root, rel),
    readDir: (abs) => port.readDir(abs),
    lstat: (abs) => port.lstat(abs),
    readFile: (abs) => port.readFile(abs),
    writeFile: (abs, data, mode) => port.writeFile(abs, data, mode),
    mkdirp: (abs) => port.mkdirp(abs),
  };
}

export async function setup(
  files: Record<string, string | Uint8Array>,
  options: { watch?: boolean; at?: Date; open?: boolean } = {},
): Promise<Harness> {
  const port = new MemoryFsPort();
  port.seed(files);
  const vault = new LocalFsProvider(options.watch === false ? withoutWatch(port) : port);
  let closeHandler: (() => Promise<boolean>) | null = null;
  const platform = {
    vault,
    onCloseRequested(handler: () => Promise<boolean>) {
      closeHandler = handler;
      return () => {};
    },
    closeWindow: vi.fn(async () => {}),
    log: vi.fn(),
  };
  const at = options.at ?? new Date(2026, 9, 6, 9, 30, 0);
  const app = createAppController(platform, {
    now: () => at.getTime(),
    setTimeout: (callback, ms) => setTimeout(callback, ms),
    clearTimeout: (handle) => clearTimeout(handle as number),
  });
  platform.onCloseRequested(() => app.sync.requestWindowClose());
  if (options.open !== false) await app.sync.openVault('welcome');
  return {
    app,
    port,
    platform,
    writes: () => port.calls().filter((call) => call.op === 'writeFile').length,
    type(id, text) {
      const record = app.registry.get(id);
      if (!record) throw new Error(`aba sem documento: ${id}`);
      const { state } = record.state.update({
        changes: { from: record.state.doc.length, insert: text },
      });
      app.sync.onEditorChange(id, state);
    },
    text: (id) => app.registry.get(id)?.state.doc.toString(),
    async settle() {
      await vi.advanceTimersByTimeAsync(0);
    },
    requestClose: () => (closeHandler ? closeHandler() : Promise.resolve(true)),
  };
}
