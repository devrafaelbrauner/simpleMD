import type { PluginManifest } from '../types';

/**
 * Descoberta e validação de manifestos (arch-backend r2 §1.3.1; R-6.4, R-6.5). Puro sobre uma
 * porta: o app a implementa sobre o provider do vault. Nenhum `main.js` é lido aqui — só o
 * `stat` dele (tamanho), então um manifesto inválido nunca chega a executar código (NFR-36).
 */
export interface PluginDirPort {
  /** Itens de `.simplemd/plugins` (sem os ocultos); pasta ausente → `[]`. */
  listPluginFolders(): Promise<ReadonlyArray<{ name: string; kind: string }>>;
  /** Bytes do `manifest.json`; acima de 64 KB rejeita com `{ code: 'TOO_LARGE' }` sem ler. */
  readManifest(folder: string): Promise<Uint8Array>;
  /** Tamanho do `main` (0 leituras); `null` se não existe. */
  statMain(folder: string, main: string): Promise<{ size: number } | null>;
}

export type PluginRecord =
  | {
      readonly kind: 'valid';
      readonly folder: string;
      readonly manifest: PluginManifest;
    }
  | {
      readonly kind: 'incompatible';
      readonly folder: string;
      readonly manifest: PluginManifest;
      readonly reason: string;
    }
  | {
      readonly kind: 'invalid';
      readonly folder: string;
      readonly field: string;
      readonly reason: string;
      /** O que deu para ler do manifesto, só para exibir a linha (nome, versão, id válido). */
      readonly display: {
        readonly name: string;
        readonly version: string | null;
        readonly id: string | null;
      };
    };

export const MANIFEST_MAX_BYTES = 64 * 1024;
export const MAIN_MAX_BYTES = 5 * 1024 * 1024;
export const PLUGINS_DIR = '.simplemd/plugins';

const ID_RE = /^[a-z0-9]+(\.[a-z0-9-]+)+$/;
const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;
const MAIN_RE = /^[A-Za-z0-9._/-]+\.js$/;
// eslint-disable-next-line no-control-regex -- recusar caracteres de controle é o objetivo
const CONTROL_RE = /[\x00-\x1f\x7f]/;
const decoder = new TextDecoder('utf-8', { fatal: true });

/** Precedência SemVer 2.0 (pré-lançamento incluído; metadados de build ignorados). */
export function compareSemver(a: string, b: string): number {
  const pa = SEMVER_RE.exec(a);
  const pb = SEMVER_RE.exec(b);
  if (!pa || !pb) throw new TypeError(`versão inválida: ${pa ? b : a}`);
  for (let i = 1; i <= 3; i++) {
    const diff = Number(pa[i]) - Number(pb[i]);
    if (diff !== 0) return Math.sign(diff);
  }
  const preA = pa[4];
  const preB = pb[4];
  if (preA === undefined || preB === undefined) {
    return preA === preB ? 0 : preA === undefined ? 1 : -1;
  }
  const idsA = preA.split('.');
  const idsB = preB.split('.');
  for (let i = 0; i < Math.max(idsA.length, idsB.length); i++) {
    const x = idsA[i];
    const y = idsB[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) {
      const diff = Number(x) - Number(y);
      if (diff !== 0) return Math.sign(diff);
    } else if (nx !== ny) {
      return nx ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

const fieldReason = (field: string, why: string) => `Manifesto inválido — campo “${field}”: ${why}`;

type Validation =
  | { readonly ok: true; readonly manifest: PluginManifest }
  | { readonly ok: false; readonly field: string; readonly reason: string };

/**
 * Valida o manifesto já decodificado na ordem de arch-backend r2 §1.3.1 (passos 2–6); a primeira
 * falha nomeia o campo (AC-6.4). Chaves desconhecidas são ignoradas (compatibilidade futura).
 */
export function validateManifest(bytes: Uint8Array, folder: string): Validation {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(bytes));
  } catch {
    return { ok: false, field: 'manifest.json', reason: 'Manifesto inválido — JSON malformado.' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, field: 'manifest.json', reason: 'Manifesto inválido — JSON malformado.' };
  }
  const raw = parsed as Record<string, unknown>;
  for (const field of ['id', 'name', 'version', 'minAppVersion', 'main'] as const) {
    if (typeof raw[field] !== 'string' || raw[field] === '') {
      return { ok: false, field, reason: fieldReason(field, 'obrigatório (texto).') };
    }
  }
  if (raw.description !== undefined && typeof raw.description !== 'string') {
    return {
      ok: false,
      field: 'description',
      reason: fieldReason('description', 'deve ser texto.'),
    };
  }
  const { id, name, version, minAppVersion, main } = raw as Pick<
    PluginManifest,
    'id' | 'name' | 'version' | 'minAppVersion' | 'main'
  >;
  const description = raw.description as string | undefined;
  if (name.length > 80 || CONTROL_RE.test(name)) {
    return {
      ok: false,
      field: 'name',
      reason: fieldReason('name', 'até 80 caracteres, sem controle.'),
    };
  }
  if (description !== undefined && (description.length > 500 || CONTROL_RE.test(description))) {
    return {
      ok: false,
      field: 'description',
      reason: fieldReason('description', 'até 500 caracteres, sem controle.'),
    };
  }
  if (id.length > 128 || !ID_RE.test(id)) {
    return {
      ok: false,
      field: 'id',
      reason: fieldReason(
        'id',
        'use letras minúsculas, números e pontos (ex.: com.exemplo.plugin).',
      ),
    };
  }
  if (id !== folder) {
    return { ok: false, field: 'id', reason: fieldReason('id', `difere da pasta “${folder}”.`) };
  }
  if (!SEMVER_RE.test(version)) {
    return {
      ok: false,
      field: 'version',
      reason: fieldReason('version', 'não é SemVer (ex.: 1.0.0).'),
    };
  }
  if (!SEMVER_RE.test(minAppVersion)) {
    return {
      ok: false,
      field: 'minAppVersion',
      reason: fieldReason('minAppVersion', 'não é SemVer (ex.: 0.1.0).'),
    };
  }
  const segments = main.split('/');
  const badMain =
    main.length > 128 ||
    main.startsWith('/') ||
    /^[A-Za-z]:/.test(main) ||
    main.includes('\\') ||
    segments.includes('..') ||
    segments.some((s) => s === '' || s.startsWith('.')) ||
    !MAIN_RE.test(main);
  if (badMain) {
    return {
      ok: false,
      field: 'main',
      reason: fieldReason('main', 'caminho relativo de um arquivo .js dentro da pasta do plugin.'),
    };
  }
  const manifest: PluginManifest = { id, name, version, minAppVersion, main };
  if (description !== undefined) manifest.description = description;
  return { ok: true, manifest };
}

function display(
  bytes: Uint8Array | null,
  folder: string,
): {
  name: string;
  version: string | null;
  id: string | null;
} {
  try {
    const raw = bytes ? (JSON.parse(decoder.decode(bytes)) as Record<string, unknown>) : null;
    const text = (key: string) => (typeof raw?.[key] === 'string' ? (raw[key] as string) : null);
    const id = text('id');
    return {
      name: (text('name') ?? folder).slice(0, 80),
      version: text('version'),
      id: id !== null && ID_RE.test(id) ? id : null,
    };
  } catch {
    return { name: folder, version: null, id: null };
  }
}

const errorCode = (error: unknown) =>
  typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';

/** Uma pasta → um registro (passos 1–8 de §1.3.1). */
async function inspect(
  port: PluginDirPort,
  folder: string,
  appVersion: string,
): Promise<PluginRecord> {
  let bytes: Uint8Array;
  try {
    bytes = await port.readManifest(folder);
  } catch (error) {
    const code = errorCode(error);
    const reason =
      code === 'TOO_LARGE'
        ? fieldReason('manifest.json', 'maior que 64 KB.')
        : code === 'NOT_FOUND'
          ? fieldReason('manifest.json', 'arquivo não encontrado.')
          : fieldReason('manifest.json', 'não foi possível ler.');
    return {
      kind: 'invalid',
      folder,
      field: 'manifest.json',
      reason,
      display: display(null, folder),
    };
  }
  if (bytes.length > MANIFEST_MAX_BYTES) {
    return {
      kind: 'invalid',
      folder,
      field: 'manifest.json',
      reason: fieldReason('manifest.json', 'maior que 64 KB.'),
      display: display(null, folder),
    };
  }
  const result = validateManifest(bytes, folder);
  if (!result.ok) {
    return {
      kind: 'invalid',
      folder,
      field: result.field,
      reason: result.reason,
      display: display(bytes, folder),
    };
  }
  const { manifest } = result;
  const stat = await port.statMain(folder, manifest.main).catch(() => null);
  if (stat === null) {
    return {
      kind: 'invalid',
      folder,
      field: 'main',
      reason: fieldReason('main', 'arquivo não encontrado.'),
      display: display(bytes, folder),
    };
  }
  if (stat.size > MAIN_MAX_BYTES) {
    return {
      kind: 'invalid',
      folder,
      field: 'main',
      reason: fieldReason('main', 'main.js maior que 5 MB.'),
      display: display(bytes, folder),
    };
  }
  if (compareSemver(manifest.minAppVersion, appVersion) > 0) {
    return {
      kind: 'incompatible',
      folder,
      manifest,
      reason: `requer simpleMD ≥ ${manifest.minAppVersion}`,
    };
  }
  return { kind: 'valid', folder, manifest };
}

/**
 * Lista as pastas diretas de `.simplemd/plugins` (arquivos nesse nível são ignorados; links
 * simbólicos ficam `Inválido`), valida cada manifesto e devolve os registros em ordem de id.
 */
export async function discoverPlugins(
  port: PluginDirPort,
  appVersion: string,
): Promise<PluginRecord[]> {
  const items = await port.listPluginFolders();
  const folders = items
    .filter((item) => item.kind === 'dir' || item.kind === 'symlink')
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return Promise.all(
    folders.map((item): Promise<PluginRecord> | PluginRecord =>
      item.kind === 'symlink'
        ? {
            kind: 'invalid',
            folder: item.name,
            field: 'pasta',
            reason: fieldReason('pasta', 'link simbólico não é seguido.'),
            display: { name: item.name, version: null, id: null },
          }
        : inspect(port, item.name, appVersion),
    ),
  );
}
