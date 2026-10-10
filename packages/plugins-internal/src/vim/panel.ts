import { translateVimMessage } from './messages';

/** Nomes acessíveis dos inputs do painel W6 (STR-160, A-44). */
export const PROMPT_LABELS = { command: 'Comando do Vim', search: 'Buscar no Vim' } as const;

/** O que o painel usa do adaptador `CodeMirror` do `@replit/codemirror-vim` 6.4.0. */
export interface VimDialogHost {
  openDialog(
    template: Element,
    callback: ((value: string) => void) | undefined,
    options: unknown,
  ): (value?: string) => void;
  openNotification(template: Node, options: { bottom?: boolean; duration?: number }): () => void;
}

/** Prefixos que o próprio rótulo já diz (`:` comando; `/` e `?` busca) → rótulo do input. */
const KNOWN_PREFIXES: Readonly<Record<string, string>> = {
  ':': PROMPT_LABELS.command,
  '/': PROMPT_LABELS.search,
  '?': PROMPT_LABELS.search,
};

/**
 * Prompt `:`/`/`/`?` (W6, DESIGN §R7.6.10): input com `aria-label` pt-BR; prefixo conhecido em
 * `.cm-vim-prefix` (`aria-hidden`: o rótulo já o diz); prefixo ou descrição em inglês da biblioteca
 * (confirmação de `:s///c`, alternância `pcre` da busca) marcados `lang="en"`. Os estilos em linha da
 * biblioteca (`monospace`, `#888`) saem: o tema do plugin decide pelos tokens.
 */
export function localizePrompt(template: Element): void {
  const input = template.querySelector('input');
  const field = input?.parentElement;
  if (!input || !field) return;
  const before: ChildNode[] = [];
  for (const node of Array.from(field.childNodes)) {
    if (node === input) break;
    before.push(node);
  }
  const prefixText = before.map((node) => node.textContent ?? '').join('');
  const known = Object.hasOwn(KNOWN_PREFIXES, prefixText) ? KNOWN_PREFIXES[prefixText] : undefined;
  const prefix = document.createElement('span');
  prefix.className = 'cm-vim-prefix';
  if (known) prefix.setAttribute('aria-hidden', 'true');
  else prefix.lang = 'en';
  prefix.append(...before);
  field.insertBefore(prefix, input);
  field.classList.add('cm-vim-field');
  field.style.removeProperty('font-family');
  input.setAttribute('aria-label', known ?? PROMPT_LABELS.command);
  for (const extra of Array.from(template.children)) {
    if (extra === field || !(extra instanceof HTMLElement)) continue;
    extra.classList.add('cm-vim-desc');
    extra.lang = 'en';
    extra.style.removeProperty('color');
  }
}

/**
 * Mensagem do Vim (STR-161): troca o modelo da biblioteca (texto inglês em vermelho) por um
 * `role="status"` com cada linha traduzida, ou no original dentro de `<span lang="en">`.
 */
export function localizeNotification(template: Node): HTMLElement {
  const out = document.createElement('div');
  out.className = 'cm-vim-message';
  out.setAttribute('role', 'status');
  const parts =
    template instanceof Element && !template.classList.contains('cm-vim-message')
      ? Array.from(template.childNodes)
      : [template];
  for (const part of parts) {
    const original = part.textContent ?? '';
    if (!original) continue;
    const message = translateVimMessage(original);
    const line = document.createElement('div');
    if (message.lang === 'en') {
      const span = document.createElement('span');
      span.lang = 'en';
      span.textContent = message.text;
      line.append(span);
    } else {
      line.textContent = message.text;
    }
    out.append(line);
  }
  return out;
}

/** Instala a tradução no adaptador de UM editor (antes de o modelo entrar no painel). */
export function localizeDialogs(cm: VimDialogHost): void {
  const openDialog = cm.openDialog.bind(cm);
  const openNotification = cm.openNotification.bind(cm);
  cm.openDialog = (template, callback, options) => {
    localizePrompt(template);
    return openDialog(template, callback, options);
  };
  cm.openNotification = (template, options) =>
    openNotification(localizeNotification(template), options);
}
