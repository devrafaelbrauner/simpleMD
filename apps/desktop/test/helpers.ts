import type { InternalPlugin, ModuleEvaluator } from '@simplemd/plugin-api/runtime';
import { VAULT_READ_LIMITS, type ThemeBase, type Tokens } from '@simplemd/themes';
import { LocalFsProvider, type FsPort } from '@simplemd/vault';
import { MemoryFsPort } from '@simplemd/vault/testing';
import { vi, type Mock } from 'vitest';
import { createHarnessAi, type HarnessAiControl } from '../harness/ai';
import { createMemoryApprovals, type MemoryApprovals } from '../harness/approvals';
import { createAppController, type AppController } from '../src/app/controller';
import type { AppPlatform, PickedFile } from '../src/platform/types';
import type { RootTarget } from '../src/state/settings';

/** Dublê do `<html>`: registra o que seria aplicado (os testes do desktop rodam sem DOM). */
export interface RecordingRoot extends RootTarget {
  readonly applied: Array<{ tokens: Tokens; base: ThemeBase; mark: string }>;
  readonly ligatures: boolean[];
  readonly fonts: string[];
}

export function recordingRoot(): RecordingRoot {
  const applied: RecordingRoot['applied'] = [];
  const ligatures: boolean[] = [];
  const fonts: string[] = [];
  return {
    applied,
    ligatures,
    fonts,
    applyTheme: (tokens, base, mark) => void applied.push({ tokens, base, mark }),
    setLigatures: (on) => void ligatures.push(on),
    loadFont: async (family, size) => void fonts.push(`${size}px "${family}"`),
  };
}

export interface Harness {
  readonly app: AppController;
  readonly port: MemoryFsPort;
  readonly root: RecordingRoot;
  readonly platform: AppPlatform & {
    closeWindow: Mock<() => Promise<void>>;
    saveFile: Mock<(name: string, bytes: Uint8Array) => Promise<string | null>>;
    pickFile: Mock<() => Promise<PickedFile | null>>;
    approvals: MemoryApprovals;
  };
  /** IA do harness (H14): replay das fixtures, chamadas sem segredo, keychain falso. */
  readonly ai: HarnessAiControl;
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
  options: {
    watch?: boolean;
    at?: Date;
    open?: boolean;
    evaluator?: ModuleEvaluator;
    /** Plugins internos (padrão `[]`: os testes de sincronização não carregam Mermaid/KaTeX/calc). */
    internal?: readonly InternalPlugin[];
    /** Índice do vault (padrão `false`: as contagens de leitura/gravação do r1 ficam iguais). */
    catalog?: boolean;
  } = {},
): Promise<Harness> {
  const port = new MemoryFsPort();
  port.seed(files);
  const vault = new LocalFsProvider(options.watch === false ? withoutWatch(port) : port, {
    readLimits: VAULT_READ_LIMITS,
  });
  let closeHandler: (() => Promise<boolean>) | null = null;
  const harnessAi = createHarnessAi();
  const platform = {
    vault,
    onCloseRequested(handler: () => Promise<boolean>) {
      closeHandler = handler;
      return () => {};
    },
    closeWindow: vi.fn(async () => {}),
    log: vi.fn(),
    saveFile: vi.fn<(name: string, bytes: Uint8Array) => Promise<string | null>>(
      async (name) => `/exportados/${name}`,
    ),
    pickFile: vi.fn(async (): Promise<PickedFile | null> => null),
    approvals: createMemoryApprovals(),
    ai: harnessAi.platform,
  };
  const at = options.at ?? new Date(2026, 9, 6, 9, 30, 0);
  const root = recordingRoot();
  const app = createAppController(
    platform,
    {
      now: () => at.getTime(),
      setTimeout: (callback, ms) => setTimeout(callback, ms),
      clearTimeout: (handle) => clearTimeout(handle as number),
    },
    root,
    {
      ...(options.evaluator ? { evaluator: options.evaluator } : {}),
      internal: options.internal ?? [],
      catalog: options.catalog ?? false,
    },
  );
  platform.onCloseRequested(() => app.sync.requestWindowClose());
  if (options.open !== false) await app.sync.openVault('welcome');
  return {
    app,
    port,
    root,
    platform,
    ai: harnessAi.control,
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
