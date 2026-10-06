import {
  REQUIRED_TOKENS,
  clampFontSize,
  lightTokens,
  type RequiredToken,
  type ThemeBase,
  type Tokens,
} from '@simplemd/themes';

/**
 * Rascunho do editor de temas (arch-frontend §10): estado local, puro e testável. Os campos de
 * texto guardam o que o usuário digitou (`inputs`); `tokens` guarda o último valor VÁLIDO de cada
 * token, que é o que a prévia mostra e o que é salvo (TED-INVALID).
 */
export type DraftField = 'name' | RequiredToken;

export interface Draft {
  readonly startId: string;
  readonly name: string;
  readonly base: ThemeBase;
  readonly inputs: Readonly<Record<RequiredToken, string>>;
  readonly tokens: Readonly<Record<RequiredToken, string>>;
  readonly errors: Readonly<Partial<Record<DraftField, string>>>;
  /** Campos que já mostraram um erro: daí em diante validam a cada tecla (DESIGN §9). */
  readonly live: Readonly<Partial<Record<DraftField, true>>>;
}

export interface StartTheme {
  readonly id: string;
  readonly name: string;
  readonly base: ThemeBase;
  /** Tokens já resolvidos (tema sobre a base), sem as preferências do usuário. */
  readonly tokens: Tokens;
}

export type DraftAction =
  | { readonly type: 'start'; readonly theme: StartTheme }
  | { readonly type: 'name'; readonly value: string }
  | { readonly type: 'base'; readonly base: ThemeBase }
  | { readonly type: 'input'; readonly token: RequiredToken; readonly value: string }
  /** Seletor nativo de cor: só `#rrggbb`; o alfa do valor atual é mantido. */
  | { readonly type: 'picker'; readonly token: RequiredToken; readonly value: string }
  /** Sair do campo (ou Enter no tamanho): valida/limita. */
  | { readonly type: 'commit'; readonly field: DraftField }
  | { readonly type: 'validate-all' };

export const HEX_ERROR = 'Use uma cor hexadecimal: #rgb, #rgba, #rrggbb ou #rrggbbaa.';
export const NAME_ERROR = 'Informe um nome com pelo menos uma letra ou número.';
export const SUMMARY_ERROR = 'Corrija os campos destacados antes de salvar.';

const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const NAME_MAX = 64;
export const COLOR_TOKENS = REQUIRED_TOKENS.filter((t) => t.startsWith('--color-'));
export const SIZE_TOKEN = '--dimension-font-size';

const isColor = (token: string) => token.startsWith('--color-');

/** `#rgb`/`#rgba`/`#rrggbbaa` → `#rrggbb` (o `<input type=color>` só aceita esta forma). */
export function pickerValue(hex: string): string {
  if (!HEX.test(hex)) return '#000000';
  const digits = hex.slice(1);
  const rgb =
    digits.length <= 4 ? [...digits.slice(0, 3)].map((c) => c + c).join('') : digits.slice(0, 6);
  return `#${rgb.toLowerCase()}`;
}

/** Junta o `#rrggbb` do seletor com o alfa do valor atual, se houver (arch-frontend §10). */
export function withAlpha(picked: string, current: string): string {
  const digits = HEX.test(current) ? current.slice(1) : '';
  if (digits.length === 8) return `${picked}${digits.slice(6)}`;
  if (digits.length === 4) return `${picked}${digits.slice(3).repeat(2)}`;
  return picked;
}

/** `17px` → 17; outra unidade ou valor inválido → o tamanho do tema claro, limitado a 10–32. */
export function sizeFromToken(value: string | undefined): number {
  const parsed = Number.parseFloat(value ?? '');
  const fallback = Number.parseFloat(lightTokens[SIZE_TOKEN] ?? '');
  return clampFontSize(Number.isFinite(parsed) ? parsed : fallback);
}

function nameError(name: string): string | undefined {
  const trimmed = name.trim();
  return /[\p{L}\p{N}]/u.test(trimmed) && trimmed.length <= NAME_MAX ? undefined : NAME_ERROR;
}

function fieldError(draft: Draft, field: DraftField): string | undefined {
  if (field === 'name') return nameError(draft.name);
  if (isColor(field)) return HEX.test(draft.inputs[field]) ? undefined : HEX_ERROR;
  return undefined;
}

function setError(
  draft: Draft,
  field: DraftField,
  error: string | undefined,
  show: boolean,
): Draft {
  const errors = { ...draft.errors };
  const live = { ...draft.live };
  if (error === undefined) delete errors[field];
  else if (show) {
    errors[field] = error;
    live[field] = true;
  }
  return { ...draft, errors, live };
}

export function startDraft(theme: StartTheme): Draft {
  const values = {} as Record<RequiredToken, string>;
  for (const token of REQUIRED_TOKENS)
    values[token] = theme.tokens[token] ?? lightTokens[token] ?? '';
  values[SIZE_TOKEN] = `${sizeFromToken(values[SIZE_TOKEN])}px`;
  const inputs = { ...values, [SIZE_TOKEN]: String(sizeFromToken(values[SIZE_TOKEN])) };
  return {
    startId: theme.id,
    name: `${theme.name} (cópia)`,
    base: theme.base,
    inputs,
    tokens: values,
    errors: {},
    live: {},
  };
}

export function draftReducer(draft: Draft, action: DraftAction): Draft {
  switch (action.type) {
    case 'start':
      return startDraft(action.theme);
    case 'name': {
      const next = { ...draft, name: action.value };
      return draft.live.name ? setError(next, 'name', nameError(action.value), true) : next;
    }
    case 'base':
      return { ...draft, base: action.base };
    case 'input': {
      const { token, value } = action;
      const next: Draft = { ...draft, inputs: { ...draft.inputs, [token]: value } };
      if (isColor(token)) {
        // Valor válido vai para a prévia na hora; inválido mantém o último válido.
        const valid = HEX.test(value);
        const withToken = valid ? { ...next, tokens: { ...next.tokens, [token]: value } } : next;
        return draft.live[token]
          ? setError(withToken, token, valid ? undefined : HEX_ERROR, true)
          : withToken;
      }
      if (token === SIZE_TOKEN) return next; // limitado só ao confirmar (UX-D17)
      return { ...next, tokens: { ...next.tokens, [token]: value } };
    }
    case 'picker': {
      const value = withAlpha(action.value, draft.tokens[action.token]);
      return setError(
        {
          ...draft,
          inputs: { ...draft.inputs, [action.token]: value },
          tokens: { ...draft.tokens, [action.token]: value },
        },
        action.token,
        undefined,
        false,
      );
    }
    case 'commit': {
      const { field } = action;
      if (field === SIZE_TOKEN) {
        const typed = Number(draft.inputs[SIZE_TOKEN]);
        const size =
          draft.inputs[SIZE_TOKEN].trim() === '' || !Number.isFinite(typed)
            ? sizeFromToken(draft.tokens[SIZE_TOKEN])
            : clampFontSize(typed);
        return {
          ...draft,
          inputs: { ...draft.inputs, [SIZE_TOKEN]: String(size) },
          tokens: { ...draft.tokens, [SIZE_TOKEN]: `${size}px` },
        };
      }
      return setError(draft, field, fieldError(draft, field), true);
    }
    case 'validate-all': {
      let next = draft;
      for (const field of ['name', ...COLOR_TOKENS] as DraftField[])
        next = setError(next, field, fieldError(next, field), true);
      return next;
    }
  }
}

/** Primeiro campo com erro, na ordem do formulário (o foco vai para ele ao salvar). */
export function firstInvalid(draft: Draft): DraftField | undefined {
  return (['name', ...COLOR_TOKENS] as DraftField[]).find((f) => draft.errors[f] !== undefined);
}
