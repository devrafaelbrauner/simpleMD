import '@simplemd/themes/tokens.css';
import '@simplemd/themes/fonts.css';
import '@simplemd/ui/styles/app.css';
import { VAULT_READ_LIMITS } from '@simplemd/themes';
import {
  LocalFsProvider,
  VaultError,
  type FsPort,
  type VaultErrorCode,
  type WriteMode,
} from '@simplemd/vault';
import {
  MEMORY_ROOT,
  MemoryFsPort,
  type MemoryFault,
  type MemoryOp,
  type MemorySnapshot,
} from '@simplemd/vault/testing';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '../src/app/App';
import { createAppController } from '../src/app/controller';
import type { AppPlatform } from '../src/platform/types';
import { systemClock, type Clock } from '../src/state/sync';
import { PRESETS, isPresetId, type PresetId } from './fixtures';
import { sha256Hex } from './sha256';

/**
 * Harness do Chromium (D-6, R-2.12): a MESMA árvore React do app, com o `LocalFsProvider` de
 * produção sobre a porta em memória. Existe só neste bundle (`build/harness`); o build do Tauri
 * nunca o alcança (lint + `scripts/assert-no-harness.mjs`).
 *
 * URL: `?vault=FX-…` abre o vault pronto; `&expand=all` expande todas as pastas; `&persist=1`
 * guarda o vault em `sessionStorage` e o restaura no recarregamento.
 */
type HarnessOp = 'pick' | 'list' | 'lstat' | 'read' | 'write' | 'mkdir';

interface HarnessCall {
  readonly op: HarnessOp;
  readonly path: string;
  readonly bytes?: number;
  readonly sha256?: string;
  readonly mode?: WriteMode;
  readonly ts: number;
}

const OP_NAMES: Record<MemoryOp, HarnessOp> = {
  pickDirectory: 'pick',
  readDir: 'list',
  lstat: 'lstat',
  readFile: 'read',
  writeFile: 'write',
  mkdirp: 'mkdir',
};
const FAULT_OPS: Record<'list' | 'read' | 'write', MemoryOp> = {
  list: 'readDir',
  read: 'readFile',
  write: 'writeFile',
};
const PERSIST_KEY = 'simplemd:harness-vault';

const params = new URLSearchParams(window.location.search);
const presetParam = params.get('vault');
const persist = params.get('persist') === '1';

let port = new MemoryFsPort();
let autoOpen = false;
let fixedClock: number | null = null;
let calls: HarnessCall[] = [];
/** Falhas ficam no harness (sobrevivem à troca de pasta, que cria uma árvore nova). */
let faults: MemoryFault[] = [];
let closeHandler: (() => Promise<boolean>) | null = null;

const relative = (abs: string) =>
  abs.startsWith(`${MEMORY_ROOT}/`) ? abs.slice(MEMORY_ROOT.length + 1) : abs;

/** Registra a chamada (H4) e aplica falha/atraso injetados (H3) antes de delegar. */
async function enter(op: MemoryOp, abs: string, extra: Partial<HarnessCall> = {}): Promise<void> {
  calls.push({ op: OP_NAMES[op], path: relative(abs), ts: Date.now(), ...extra });
  const fault = faults.find(
    (f) => f.op === op && (f.path === undefined || f.path === relative(abs)),
  );
  if (!fault) return;
  if (fault.once) faults = faults.filter((f) => f !== fault);
  if (fault.delayMs) {
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, fault.delayMs);
    await promise;
  }
  if (fault.error)
    throw new VaultError(fault.error, `Falha injetada (${fault.error}).`, { path: abs });
}

function seed(preset: PresetId): void {
  port = new MemoryFsPort();
  port.seed(PRESETS[preset]());
}

/** Porta que delega à porta em memória atual (cada "pasta escolhida" é uma árvore nova). */
const harnessPort: FsPort = {
  async pickDirectory() {
    await enter('pickDirectory', MEMORY_ROOT);
    if (autoOpen) {
      autoOpen = false;
      return MEMORY_ROOT;
    }
    const choice = harness.dialogs.open;
    if (choice === 'cancel') return null;
    seed(choice);
    return MEMORY_ROOT;
  },
  join: (root, rel) => port.join(root, rel),
  async readDir(abs) {
    await enter('readDir', abs);
    return port.readDir(abs);
  },
  async lstat(abs) {
    await enter('lstat', abs);
    return port.lstat(abs);
  },
  async readFile(abs) {
    await enter('readFile', abs);
    return port.readFile(abs);
  },
  async writeFile(abs, data, mode) {
    await enter('writeFile', abs, { bytes: data.length, sha256: sha256Hex(data), mode });
    return port.writeFile(abs, data, mode);
  },
  async mkdirp(abs) {
    await enter('mkdirp', abs);
    return port.mkdirp(abs);
  },
  watch: (abs, onPaths) => port.watch(abs, onPaths),
};

const clock: Clock = { ...systemClock, now: () => fixedClock ?? Date.now() };

const platform: AppPlatform = {
  vault: new LocalFsProvider(harnessPort, { readLimits: VAULT_READ_LIMITS }),
  onCloseRequested(handler) {
    closeHandler = handler;
    return () => {
      if (closeHandler === handler) closeHandler = null;
    };
  },
  async closeWindow() {
    harness.windowClosed = true;
  },
  log(event) {
    console.info(`${event} ${Date.now()}`);
  },
  /** H6: `dialogs.save` = 'download' (download do navegador), 'cancel' ou 'fail'. */
  async saveFile(suggestedName, bytes) {
    const choice = harness.dialogs.save;
    if (choice === 'cancel') return null;
    if (choice === 'fail') throw new Error('Falha injetada ao exportar.');
    harness.exports.push({ name: suggestedName, sha256: sha256Hex(bytes), size: bytes.length });
    const url = URL.createObjectURL(
      new Blob([new Uint8Array(bytes)], { type: 'application/json' }),
    );
    const link = Object.assign(document.createElement('a'), { href: url, download: suggestedName });
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    return suggestedName;
  },
  // Sem `pickFile`: a importação usa o `<input type=file>` `set-import-input` (H7).
};

const app = createAppController(platform, clock);

function bytesOf(path: string): Uint8Array {
  const bytes = port.readBytes(path);
  if (bytes === null) throw new Error(`arquivo inexistente no vault em memória: ${path}`);
  return bytes;
}

const harness = {
  dialogs: {
    open: 'FX-SMALL' as PresetId | 'cancel',
    save: 'download' as 'download' | 'cancel' | 'fail',
  },
  /** Exportações feitas (nome, sha256 e tamanho dos bytes entregues ao download). */
  exports: [] as Array<{ name: string; sha256: string; size: number }>,
  windowClosed: false,
  /** H2: mudanças feitas "por outro programa" (disparam a observação). */
  externalWrite: (path: string, text: string) => port.externalWrite(path, text),
  touch: (path: string) => port.touch(path),
  remove: (path: string) => port.remove(path),
  symlink: (path: string, target: string) => port.symlink(path, target),
  readText: (path: string) => port.readText(path),
  sha256: (path: string) => sha256Hex(bytesOf(path)),
  /** H3: falha e/ou atraso por operação (`once` remove a falha depois do primeiro uso). */
  fault(
    op: 'list' | 'read' | 'write',
    options: { error?: VaultErrorCode; delayMs?: number; once?: boolean; path?: string } = {},
  ) {
    faults.push({ op: FAULT_OPS[op], ...options });
  },
  clearFaults() {
    faults = [];
  },
  /** H4: registro de chamadas à porta (escritas com tamanho e sha256). */
  calls: (): readonly HarnessCall[] => calls,
  resetCalls() {
    calls = [];
  },
  /** H10: fixa a hora usada no nome da cópia de conflito. */
  setClock(iso: string | null) {
    fixedClock = iso === null ? null : Date.parse(iso);
  },
  /** Simula o botão fechar da janela (flush; L1/L4 quando não dá para fechar). */
  async requestWindowClose(): Promise<boolean> {
    const allowed = closeHandler ? await closeHandler() : true;
    if (allowed) harness.windowClosed = true;
    return allowed;
  },
  expandAll: () => app.store.getState().expandAll(),
};

declare global {
  interface Window {
    __simplemdHarness: typeof harness;
  }
}
window.__simplemdHarness = harness;

async function start(): Promise<void> {
  const stored = persist ? sessionStorage.getItem(PERSIST_KEY) : null;
  if (stored !== null) {
    port.restore(JSON.parse(stored) as MemorySnapshot);
    autoOpen = true;
  } else if (isPresetId(presetParam)) {
    seed(presetParam);
    autoOpen = true;
  }
  if (persist) {
    window.addEventListener('pagehide', () =>
      sessionStorage.setItem(PERSIST_KEY, JSON.stringify(port.snapshot())),
    );
  }
  if (autoOpen) {
    await app.sync.openVault('welcome');
    if (params.get('expand') === 'all') app.store.getState().expandAll();
  }
}

const root = document.getElementById('root');
if (!root) throw new Error('elemento #root ausente em harness/index.html');
createRoot(root).render(
  <StrictMode>
    <App app={app} />
  </StrictMode>,
);
void start();
