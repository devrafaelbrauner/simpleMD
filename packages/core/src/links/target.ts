import { validateUrl, type UrlRefusal } from './url-policy';
import { resolveVaultPath } from './vault-path';

/** Destino de um link (arch-frontend r7 §5.5); `wikilink` é acrescentado por S2. */
export type LinkTarget =
  | { readonly kind: 'external'; readonly url: string }
  | { readonly kind: 'note'; readonly path: string; readonly heading: string | null }
  | { readonly kind: 'outside-vault'; readonly raw: string }
  | { readonly kind: 'unsupported'; readonly label: string };

const SCHEME = /^([A-Za-z][A-Za-z0-9+.-]*):/;
const WEB_OR_MAIL = /^(?:https?|mailto)$/i;

/** Motivo da recusa no aviso STR-136 ("Link não suportado: <esquema ou motivo>"). */
const REFUSAL_LABEL: Readonly<Record<UrlRefusal, string>> = {
  URL_TOO_LONG: 'endereço longo demais',
  URL_CONTROL_CHAR: 'caracteres de controle',
  URL_INVALID: 'endereço inválido',
  URL_SCHEME_NOT_ALLOWED: 'endereço inválido',
  URL_CREDENTIALS: 'endereço com usuário e senha',
  URL_MAILTO_PARAM: 'endereço inválido',
};

/**
 * Classifica um destino como escrito no markdown (sem `<>`), relativo à nota `notePath`
 * (R-I1.2, R-I2.6): `http`/`https`/`mailto` válidos pelo espelho do Rust → `external` com a forma
 * normalizada (`URL.href`, SN-SEC-03); outro esquema → `unsupported` "<esquema>:"; caminho
 * relativo `.md` (com `#título` opcional) → `note`; fora do vault → `outside-vault`; outro arquivo →
 * `unsupported` ".<extensão>". `#título` sozinho = título na própria nota.
 */
export function classifyHref(raw: string, notePath: string | null): LinkTarget {
  const scheme = SCHEME.exec(raw)?.[1];
  if (scheme !== undefined) {
    if (!WEB_OR_MAIL.test(scheme))
      return { kind: 'unsupported', label: `${scheme.toLowerCase()}:` };
    const check = validateUrl(raw);
    return check.ok
      ? { kind: 'external', url: check.url.href }
      : { kind: 'unsupported', label: REFUSAL_LABEL[check.code] };
  }
  const hash = raw.indexOf('#');
  const pathPart = hash < 0 ? raw : raw.slice(0, hash);
  let heading: string | null = null;
  if (hash >= 0) {
    try {
      heading = decodeURIComponent(raw.slice(hash + 1)) || null;
    } catch {
      heading = raw.slice(hash + 1) || null;
    }
  }
  if (pathPart === '') {
    return notePath !== null && heading !== null
      ? { kind: 'note', path: notePath, heading }
      : { kind: 'unsupported', label: REFUSAL_LABEL.URL_INVALID };
  }
  const resolved = resolveVaultPath(pathPart, notePath);
  if (!resolved.ok) {
    return resolved.reason === 'outside'
      ? { kind: 'outside-vault', raw: pathPart }
      : { kind: 'unsupported', label: REFUSAL_LABEL.URL_INVALID };
  }
  const name = resolved.path.slice(resolved.path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  if (ext === 'md') return { kind: 'note', path: resolved.path, heading };
  return {
    kind: 'unsupported',
    label: ext === '' ? REFUSAL_LABEL.URL_INVALID : `.${ext}`,
  };
}

/** Destino para mostrar (dica W1 e nome acessível): URL normalizada, caminho resolvido ou cru. */
export function targetLabel(target: LinkTarget, raw: string): string {
  switch (target.kind) {
    case 'external':
      return target.url.startsWith('mailto:') ? mailAddress(target.url) : target.url;
    case 'note':
      return target.heading === null ? target.path : `${target.path}#${target.heading}`;
    default:
      return raw;
  }
}

/** Endereço(s) de um `mailto:` sem o esquema e sem a consulta. */
function mailAddress(url: string): string {
  const body = url.slice('mailto:'.length);
  const query = body.indexOf('?');
  const address = query < 0 ? body : body.slice(0, query);
  try {
    return decodeURIComponent(address);
  } catch {
    return address;
  }
}

/**
 * Nome acessível do link (STR-134): `<t> (link: <url>)`, `<t> (nota: <caminho>)`,
 * `<t> (e-mail: <endereço>)`; demais destinos com o texto como escrito.
 */
export function linkAccessibleName(text: string, target: LinkTarget, raw: string): string {
  const shown = targetLabel(target, raw);
  if (target.kind === 'note') return `${text} (nota: ${shown})`;
  if (target.kind === 'external' && target.url.startsWith('mailto:'))
    return `${text} (e-mail: ${shown})`;
  return `${text} (link: ${shown})`;
}
