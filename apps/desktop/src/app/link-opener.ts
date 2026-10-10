import type { EditorView } from '@codemirror/view';
import { computeToc, noteContext, type LinkOpener, type LinkTarget } from '@simplemd/core';
import type { AppPlatform } from '../platform/types';
import type { AppStore } from '../state/store';
import type { SyncController } from '../state/sync';

/** Textos dos avisos do serviço de links (arch-ux STR-136…STR-141; níveis DESIGN §R7.6.16). */
export const LINK_TEXT = {
  noLink: 'Nenhum link sob o cursor.',
  unsupported: (label: string) => `Link não suportado: ${label}`,
  outside: 'Link fora da pasta:',
  missing: 'Nota não encontrada:',
  heading: 'Título não encontrado:',
  openFailed: 'Não foi possível abrir o link no navegador.',
} as const;

/** Avisos do serviço se substituem (um por vez; DESIGN §R7.6.16). */
const NOTICE_KEY = 'link';
/** Quadros de espera até o editor mostrar a nota aberta (a troca de aba é um efeito do React). */
const SHOW_FRAMES = 30;

export interface LinkOpenerDeps {
  readonly platform: AppPlatform;
  readonly store: AppStore;
  readonly sync: () => SyncController;
}

/** Texto de título comparável: sem caixa, sem acento, pontuação e espaços viram `-` (âncora). */
function headingKey(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Serviço único de "abrir link" do app (arch-frontend r7 §5.5; R-I1.2, R-I2.6): ponto de registro
 * S1 → S2 (o caso `wikilink`). `external` → comando nativo `open_url` (validado de novo no Rust);
 * `note` → aba do app + rolagem ao `#título`; `.md` inexistente → aviso e 0 criações (AC-I2.5);
 * fora do vault ou esquema/arquivo não suportado → aviso, nada abre (AC-I1.4).
 */
export function createLinkOpener(deps: LinkOpenerDeps): LinkOpener {
  const { platform, store } = deps;
  const notice = (level: 'info' | 'warn' | 'error', text: string, detail?: string): void => {
    store.getState().pushNotice({
      kind: level === 'error' ? 'error' : 'info',
      ...(level === 'warn' ? { level: 'warn' as const } : {}),
      notice: 'link',
      text,
      ...(detail === undefined ? {} : { detail }),
      key: NOTICE_KEY,
    });
  };

  /** Depois de abrir a aba: cursor e rolagem no título (ausente → topo + aviso STR-140). */
  const scrollToHeading = (view: EditorView, path: string, heading: string, frames: number) => {
    if (view.state.facet(noteContext).path !== path) {
      if (frames > 0) requestAnimationFrame(() => scrollToHeading(view, path, heading, frames - 1));
      return;
    }
    const wanted = headingKey(heading);
    const flat = [...computeToc(view.state)];
    for (let i = 0; i < flat.length; i++) flat.push(...(flat[i]?.children ?? []));
    const entry = flat.find((item) => headingKey(item.text) === wanted);
    if (!entry) notice('warn', LINK_TEXT.heading, heading);
    const pos = entry?.from ?? 0;
    view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
    view.focus();
  };

  const openNote = async (target: Extract<LinkTarget, { kind: 'note' }>, view: EditorView) => {
    const handle = store.getState().handle;
    if (!handle) return;
    const stat = await platform.vault.stat(handle, target.path).catch(() => null);
    if (!stat || stat.kind !== 'file') {
      notice('warn', LINK_TEXT.missing, target.path);
      return;
    }
    if (!(await deps.sync().openFile(target.path))) return;
    if (target.heading !== null) scrollToHeading(view, target.path, target.heading, SHOW_FRAMES);
    else requestAnimationFrame(() => view.focus());
  };

  return {
    open(target, view) {
      switch (target.kind) {
        case 'external':
          platform.openUrl(target.url).catch(() => notice('error', LINK_TEXT.openFailed));
          return;
        case 'note':
          void openNote(target, view);
          return;
        case 'outside-vault':
          notice('warn', LINK_TEXT.outside, target.raw);
          return;
        case 'unsupported':
          notice('warn', LINK_TEXT.unsupported(target.label));
          return;
      }
    },
    noLink() {
      notice('info', LINK_TEXT.noLink);
    },
  };
}
