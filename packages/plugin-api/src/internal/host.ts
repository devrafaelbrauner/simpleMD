/**
 * Contexto do host para os plugins INTERNOS do simpleMD (r7 arch-frontend §3.2, D-R7-F03). Só
 * tipos, fora da API pública v1 (`src/types.ts` congelado): o registro de cada plugin interno
 * (`apps/desktop/src/plugins/internal/<id>.ts`) recebe este objeto, montado por plugin com menor
 * privilégio em `apps/desktop/src/plugins/runtime.ts` (`contextFor`), e o entrega ao código do
 * plugin em `packages/plugins-internal`. Plugins externos nunca o recebem.
 *
 * As fábricas devolvem `Extension` do núcleo (a mesma instância de `Facet` do editor); o plugin as
 * registra por `api.registerEditorExtension({ source })`, com o ciclo de vida do r2 (descarte
 * remove).
 */
import type { Extension } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import type { LanguageToolTransport } from './languagetool';

/** `tab` = Tab/Shift-Tab (só com a chave ligada); `move` = `Mod-Alt-→/←`; `indent` = `Mod-]`/`Mod-[`. */
export type ContextKind = 'tab' | 'move' | 'indent';

export interface ContextAction {
  /** Subprioridade dentro do slot (outliner 10 > fallback do núcleo 0). */
  readonly priority?: number;
  readonly kinds: readonly ContextKind[];
  run(view: EditorView, dir: 1 | -1, kind: ContextKind): boolean;
}

/** Comandos de diagnósticos registrados UMA vez pela UI compartilhada de lint/LT (S5; S8 reusa). */
export interface ProblemsCommands {
  openPanel(view: EditorView): boolean;
  next(view: EditorView): boolean;
  prev(view: EditorView): boolean;
}

/** [DA-R7-1, D-R7-F32] Só dois plugins escrevem na barra de status, cada um no seu slot tipado. */
export type VimStatus = {
  readonly mode: 'normal' | 'insert' | 'visual' | 'visual-line' | 'visual-block' | 'replace';
};
export type LtStatus =
  | { readonly state: 'checking' | 'not-found' | 'timeout' | 'manual' }
  | { readonly state: 'issues'; readonly count: number }
  | { readonly state: 'error'; readonly code: string };

/** Itens do menu M2 que o plugin do LT executa ("Como instalar" é do app). */
export type LtMenuAction = 'retry' | 'check-now';

/** Slot da barra de status de UM plugin; `T` = `VimStatus` (Vim) ou `LtStatus` (LT). */
export interface StatusSlot<T> {
  set(value: T): void;
  clear(): void;
}

export interface LtStatusSlot extends StatusSlot<LtStatus> {
  /** "Tentar de novo" / "Verificar ortografia e gramática agora" escolhidos no menu M2. */
  onAction(listener: (action: LtMenuAction) => void): () => void;
}

/** Resultado da leitura de um arquivo de configuração da lista fechada do plugin. */
export type ConfigFileRead =
  { readonly text: string } | { readonly error: 'missing' | 'too-large' | 'read' };

export interface InternalHostContext {
  readonly pluginId: string;
  readonly platform: 'mac' | 'other';
  readonly editor: {
    /** Ação num slot da cadeia de contexto (§4.4): `snippet` (LaTeX, S6) ou `list` (outliner, S7). */
    contextAction(slot: 'snippet' | 'list', action: ContextAction): Extension;
    /**
     * Semântica de conclusão das tarefas (I-9): só o registro do `simplemd.tasks` a compõe (no
     * próprio arquivo de registro, S9); para os demais fica `undefined`.
     */
    readonly taskSemantics?: (opts: { readonly recordDoneDate: () => boolean }) => Extension;
    /** Alvo de "Interagir com o elemento sob o cursor" (`Mod-Shift-Enter`; W2/W3). */
    interact(handler: (view: EditorView, pos: number) => boolean): Extension;
    /** [DA-R7-14] Dono do Escape antes do Vim: `card` (W2, S5/S8) ou `snippet` (paradas, S6). */
    escape(owner: 'card' | 'snippet', handler: (view: EditorView) => boolean): Extension;
    /**
     * [DA-R7-13] Comandos `problems:*` da paleta: privilégio só do lint e do LT (tabela de
     * `contextFor`); para os demais fica `undefined`.
     */
    readonly problems?: (commands: ProblemsCommands) => Extension;
    /** `EditorView.announce` na view principal (região polida do CM; arch-ux §7.1). */
    announce(text: string): void;
  };
  /** Slot `vim` da barra de status: só o registro do Vim o recebe (privilégio). */
  readonly vimStatus?: StatusSlot<VimStatus>;
  /** Slot `lt` da barra de status + ações do M2: só o registro do LanguageTool o recebe. */
  readonly ltStatus?: LtStatusSlot;
  readonly options: {
    /** Valor salvo (validado pelo spec) ou o padrão do spec. */
    get<T>(key: string): T;
    subscribe(listener: (key: string) => void): () => void;
  };
  /** Abre `http`/`https`/`mailto` pelo comando nativo (validação no Rust). */
  readonly links: { openExternal(url: string): void };
  /** Lista FECHADA por plugin: lint (`.markdownlint.json(c)`), LaTeX (`.simplemd/latex-snippets.json`). */
  readonly files?: {
    read(name: string): Promise<ConfigFileRead>;
    onChange(listener: (name: string) => void): () => void;
  };
  /** Só no registro do LanguageTool (contrato do backend, variante N). */
  readonly languageTool?: LanguageToolTransport;
}
