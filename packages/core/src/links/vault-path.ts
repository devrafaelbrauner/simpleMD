/**
 * Resolução de destinos relativos dentro do vault (R-I1.7, R-I2.6; arch-frontend r7 §5.4/§5.5):
 * relativo à pasta da nota, `/x` = raiz do vault, `%20` decodificado, `./` e `../` só dentro do
 * vault. Segmento oculto (`.git/`, `.env`, `.simplemd/`) = fora da pasta, sem leitura: a mesma
 * recusa do gateway (`toVaultPath`/Rust `policy.rs`), decidida aqui antes de qualquer chamada.
 * Links simbólicos e junções só o provider enxerga (recusa dele → "fora da pasta").
 */
export type VaultPathResult =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly reason: 'outside' | 'invalid' };

/** Pasta da nota (`a/b.md` → `a`; raiz ou sem nota → `''`). */
function folderOf(notePath: string | null): string {
  if (!notePath) return '';
  const slash = notePath.lastIndexOf('/');
  return slash < 0 ? '' : notePath.slice(0, slash);
}

/**
 * `raw` (destino como escrito, sem `<>`, sem `#âncora`) → caminho relativo ao vault com `/`.
 * Separador `\` conta como `/` (um `..\..\x` também sai do vault).
 */
export function resolveVaultPath(raw: string, notePath: string | null): VaultPathResult {
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (decoded === '' || decoded.includes('\0')) return { ok: false, reason: 'invalid' };
  const normalized = decoded.replace(/\\/g, '/');
  const absolute = normalized.startsWith('/');
  const segments = absolute
    ? []
    : folderOf(notePath)
        .split('/')
        .filter((s) => s !== '');
  for (const segment of normalized.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (segments.length === 0) return { ok: false, reason: 'outside' };
      segments.pop();
      continue;
    }
    if (segment.startsWith('.')) return { ok: false, reason: 'outside' };
    segments.push(segment);
  }
  if (segments.length === 0) return { ok: false, reason: 'invalid' };
  return { ok: true, path: segments.join('/') };
}
