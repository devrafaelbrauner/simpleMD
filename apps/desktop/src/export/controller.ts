import {
  detectFrontMatter,
  fileTitle,
  type ExportWikilinks,
  type ImageSource,
} from '@simplemd/core';
import { applyTheme, lightTokens } from '@simplemd/themes';
import type { AppPlatform, SaveExt, SaveTarget } from '../platform/types';
import type { DocumentRecord, DocumentRegistry } from '../state/documents';
import type { AppStore } from '../state/store';
import type { Clock } from '../state/sync';
import { decodeImages, embedImages, exportImagesNotice, printImages } from './images';
import type { PluginEnabled } from './pipeline';
import { loadPrintFonts } from './print-fonts';

/** Textos vinculantes e de estado (arch-ux r2 STR-115…STR-121). */
export const EXPORT_TEXT = {
  noTab: 'Abra uma nota para exportar.',
  noVault: 'Abra uma pasta primeiro.',
  sameAsSource: 'Escolha outro nome: este é o arquivo de origem.',
  preparingFile: 'Preparando a exportação…',
  preparingPrint: 'Preparando a impressão…',
  done: (name: string) => `Exportado para “${name}”.`,
  failed: (name: string) => `Não foi possível exportar “${name}”.`,
  denied: (name: string) => `Sem permissão para gravar em “${name}”.`,
  printFailed: 'Não foi possível abrir a impressão.',
} as const;

export type ExportKind = 'md' | 'html' | 'pdf';

/** O aviso de progresso só aparece se o trabalho passar disso (STR-118). */
export const EXPORT_PROGRESS_MS = 150;
/** Progresso e resultado se substituem (mesma chave; DESIGN §8.23). */
const NOTICE_KEY = 'export';

/** Código do erro do Rust (`{ code, message }`) ou de um `VaultError`. */
function errorCode(error: unknown): string | null {
  return typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : null;
}

/** Pipeline sob demanda (serializador, renderizadores, CSS do KaTeX; arch-frontend r2 §14.2). */
const loadPipeline = () => import('./pipeline');

export interface ExportControllerDeps {
  readonly platform: AppPlatform;
  readonly store: AppStore;
  readonly registry: DocumentRegistry;
  readonly clock: Clock;
  /** Plugin interno ligado (desligado → conteúdo cru na exportação; R-10.4). */
  readonly enabled: PluginEnabled;
  /** Cache de imagens da janela (a do editor): `blob:` das imagens do vault na impressão. */
  readonly imageSource: () => ImageSource | null;
  /** Existência dos alvos de wikilink a partir da nota exportada (r7 S2, AC-EX.3). */
  readonly wikilinks?: (notePath: string) => ExportWikilinks;
}

interface Source {
  readonly path: string;
  readonly doc: string;
  readonly record: DocumentRecord;
}

/**
 * Exportação (etapa 10; R-10.1…R-10.5, arch-frontend r2 §10): sempre do BUFFER ATUAL da aba ativa.
 * Destino pelo diálogo nativo em duas etapas (escolher → montar → gravar), com o próprio arquivo
 * de origem recusado antes de qualquer gravação (R-10.3). PDF = visualização de impressão
 * escondida na tela (`#smd-print-root`) + painel de impressão do WebView; o estado do app na tela
 * nunca muda. Nenhuma exportação grava um `.md` do vault por conta própria (regra 1).
 */
export class ExportController {
  readonly #deps: ExportControllerDeps;
  #printKeys = new Set<string>();

  constructor(deps: ExportControllerDeps) {
    this.#deps = deps;
    // F-WIN-05 (W-04): só o Chromium (WebView2/Edge; UA `Chrome/…` ou `HeadlessChrome/…`) imprime
    // o cabeçalho/rodapé dele na margem; print.css usa a página `smd-print` só com este atributo.
    if (typeof document !== 'undefined' && /Chrome\/\d/.test(navigator.userAgent))
      document.documentElement.dataset.printEngine = 'chromium';
    // A visualização de impressão fica montada até a próxima exportação ou até trocar de aba ou
    // de pasta: a folha de impressão do WKWebView não avisa quando termina (arch-backend r2 A-3).
    let { activeId, vaultStatus } = deps.store.getState();
    deps.store.subscribe((state) => {
      if (state.activeId === activeId && state.vaultStatus === vaultStatus) return;
      ({ activeId, vaultStatus } = state);
      if (!state.exportBusy) this.clearPrintView();
    });
  }

  /** As entradas de exportação podem agir? (menu, paleta e `Mod-P`; STR-115 e STR-58.) */
  enabled(): true | { reason: string } {
    const state = this.#deps.store.getState();
    if (state.vaultStatus !== 'open') return { reason: EXPORT_TEXT.noVault };
    return this.#source() ? true : { reason: EXPORT_TEXT.noTab };
  }

  /** Ponto de entrada do menu "Exportar", da paleta e do `Mod-P`. */
  start(kind: ExportKind): void {
    if (this.#deps.store.getState().exportBusy) return;
    if (kind === 'md') this.openMarkdownOptions();
    else if (kind === 'html') void this.exportHtml();
    else void this.exportPdf();
  }

  /** L7 "Exportar como Markdown" (foco inicial em "Sem front matter"). */
  openMarkdownOptions(): void {
    const source = this.#source();
    if (!source) return;
    this.#deps.store.setState({
      exportOptions: {
        hasFrontMatter: detectFrontMatter(source.doc) !== null,
        error: null,
        picking: false,
      },
    });
  }

  closeMarkdownOptions(): void {
    this.#deps.store.setState({ exportOptions: null });
  }

  /**
   * "Escolher destino…" com o L7 aberto: cancelar → volta ao L7 (silencioso); o próprio arquivo →
   * alerta STR-117 no L7 e 0 gravações; OK → o L7 fecha e a exportação roda.
   */
  async chooseMarkdown(stripFrontMatter: boolean): Promise<void> {
    const { store } = this.#deps;
    const options = store.getState().exportOptions;
    const source = this.#source();
    if (!options || options.picking || !source) return;
    store.setState({ exportOptions: { ...options, error: null, picking: true } });
    const picked = await this.#pick(source, 'md');
    const current = store.getState().exportOptions;
    if (picked === 'same-as-source') {
      if (current)
        store.setState({
          exportOptions: { ...current, error: EXPORT_TEXT.sameAsSource, picking: false },
        });
      return;
    }
    if (picked === null || picked === 'failed') {
      if (picked === 'failed') store.setState({ exportOptions: null });
      else if (current) store.setState({ exportOptions: { ...current, picking: false } });
      return;
    }
    store.setState({ exportOptions: null });
    await this.#write(picked, async () => {
      const { markdownBytes } = await loadPipeline();
      return markdownBytes(source.doc, source.record.format, stripFrontMatter);
    });
  }

  /** "Exportar como HTML…": direto ao diálogo de salvar; o próprio arquivo → aviso de erro. */
  async exportHtml(): Promise<void> {
    const source = this.#source();
    if (!source) return;
    const invoker = activeElement();
    const picked = await this.#pick(source, 'html');
    if (picked === 'same-as-source') {
      this.#notice('error', 'export-refused', EXPORT_TEXT.sameAsSource);
      restoreFocus(invoker);
      return;
    }
    if (picked === null || picked === 'failed') {
      restoreFocus(invoker);
      return;
    }
    let omitted = 0;
    const written = await this.#write(picked, async () => {
      const { exportHtml } = await loadPipeline();
      const handle = this.#deps.store.getState().handle;
      const embedded = await embedImages(source.doc, source.path, (path) =>
        handle
          ? this.#deps.platform.vault.readImage(handle, path)
          : Promise.reject(new Error('Nenhuma pasta aberta.')),
      );
      omitted = embedded.omitted;
      const html = await exportHtml(
        source.doc,
        source.path,
        this.#deps.enabled,
        embedded.images,
        this.#deps.wikilinks?.(source.path),
      );
      return new TextEncoder().encode(html);
    });
    // STR-183: o teto de 50 MiB deixou imagens só com o texto alternativo (warn; DA-R7-22).
    if (written && omitted > 0)
      this.#deps.store.getState().pushNotice({
        kind: 'info',
        level: 'warn',
        notice: 'export-images',
        text: exportImagesNotice(omitted),
        key: 'export-images',
      });
    restoreFocus(invoker);
  }

  /**
   * "Exportar como PDF…" / `Mod-P` (R-10.5): monta o conteúdo na raiz de impressão (sempre clara,
   * D-19), carrega as fontes que ela usa (até `PRINT_FONTS_TIMEOUT_MS`) e abre o painel de
   * impressão do WebView. Sem aviso de sucesso (o app não sabe se o usuário salvou); falha →
   * STR-121. O foco volta ao invocador.
   */
  async exportPdf(): Promise<void> {
    const { store, platform } = this.#deps;
    const source = this.#source();
    if (!source) {
      this.#notice('info', 'export-refused', EXPORT_TEXT.noTab);
      return;
    }
    const invoker = activeElement();
    store.setState({ exportBusy: true });
    const progress = this.#progress(EXPORT_TEXT.preparingPrint);
    const html = document.documentElement;
    let release = () => {};
    try {
      const { printBody } = await loadPipeline();
      const printed = await printImages(source.doc, source.path, this.#deps.imageSource());
      release = printed.release;
      const body = await printBody(
        source.doc,
        this.#deps.enabled,
        printed.images,
        this.#deps.wikilinks?.(source.path),
      );
      const root = document.getElementById('smd-print-root');
      if (!root) throw new Error('#smd-print-root ausente');
      // Só a saída do nosso serializador (texto escapado, HTML cru como texto; D-15), interpretada
      // num documento inerte (nada carrega nem executa ali) e só então movida para a raiz.
      const parsed = new DOMParser().parseFromString(`<body>${body}</body>`, 'text/html');
      root.replaceChildren(...parsed.body.childNodes);
      this.#printKeys = applyTheme(root, lightTokens, this.#printKeys, { base: 'light', mark: '' });
      html.dataset.printing = '';
      await loadPrintFonts(root);
      await decodeImages(root);
      progress.stop();
      store.getState().dismissNoticeKey(NOTICE_KEY);
      platform.log('simplemd:export-print');
      await platform.print();
    } catch {
      progress.stop();
      this.#notice('error', 'print-failed', EXPORT_TEXT.printFailed);
    } finally {
      release();
      delete html.dataset.printing;
      store.setState({ exportBusy: false });
      restoreFocus(invoker);
    }
  }

  /** Esvazia a visualização de impressão (nova exportação, troca de aba ou de pasta). */
  clearPrintView(): void {
    if (typeof document === 'undefined') return;
    document.getElementById('smd-print-root')?.replaceChildren();
  }

  /** Aba ativa já lida, com o documento atual (o registro acompanha cada mudança do editor). */
  #source(): Source | null {
    const { store, registry } = this.#deps;
    const { activeId, docs } = store.getState();
    if (activeId === null || docs[activeId] === undefined || docs[activeId] === 'loading')
      return null;
    const record = registry.get(activeId);
    return record ? { path: activeId, doc: record.state.doc.toString(), record } : null;
  }

  /** Diálogo nativo; `SAME_AS_SOURCE` antes de qualquer gravação; outra falha → aviso de erro. */
  async #pick(
    source: Source,
    ext: SaveExt,
  ): Promise<SaveTarget | null | 'same-as-source' | 'failed'> {
    const suggestedName = `${fileTitle(source.path)}.${ext}`;
    try {
      return await this.#deps.platform.saveTarget.pick({
        suggestedName,
        ext,
        sourceRel: source.path,
      });
    } catch (error) {
      if (errorCode(error) === 'SAME_AS_SOURCE') return 'same-as-source';
      this.#notice('error', 'export-failed', EXPORT_TEXT.failed(suggestedName));
      return 'failed';
    }
  }

  /** Monta e grava (escolher → montar → gravar), com progresso depois de 150 ms e o resultado. */
  async #write(target: SaveTarget, build: () => Promise<Uint8Array>): Promise<boolean> {
    const { store, platform } = this.#deps;
    store.setState({ exportBusy: true });
    const progress = this.#progress(EXPORT_TEXT.preparingFile);
    try {
      const bytes = await build();
      await platform.saveTarget.write(target.token, bytes);
      progress.stop();
      this.#notice('info', 'export-done', EXPORT_TEXT.done(target.fileName));
      return true;
    } catch (error) {
      progress.stop();
      const text =
        errorCode(error) === 'PERMISSION_DENIED'
          ? EXPORT_TEXT.denied(target.fileName)
          : EXPORT_TEXT.failed(target.fileName);
      this.#notice('error', 'export-failed', text);
      return false;
    } finally {
      store.setState({ exportBusy: false });
    }
  }

  #progress(text: string): { stop(): void } {
    const { clock } = this.#deps;
    const timer = clock.setTimeout(
      () => this.#notice('info', 'export-progress', text),
      EXPORT_PROGRESS_MS,
    );
    return { stop: () => clock.clearTimeout(timer) };
  }

  #notice(
    kind: 'info' | 'error',
    notice: 'export-progress' | 'export-done' | 'export-failed' | 'export-refused' | 'print-failed',
    text: string,
  ): void {
    this.#deps.store.getState().pushNotice({ kind, notice, text, key: NOTICE_KEY });
  }
}

function activeElement(): HTMLElement | null {
  if (typeof document === 'undefined') return null;
  const active = document.activeElement;
  return active instanceof HTMLElement && active !== document.body ? active : null;
}

function restoreFocus(invoker: HTMLElement | null): void {
  if (invoker?.isConnected) invoker.focus();
}
