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
import type { SpellCoverage } from './spell';

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

/**
 * [JEV D-R7-M05] Comando de paleta de um plugin interno: título exato da UX (sem o prefixo do nome
 * do plugin da API v1) e atalho que pode ser uma tecla reservada do app.
 */
export interface InternalCommand {
  /** Id completo: `<pluginId>:<id>` (ex.: `simplemd.outliner:move-up`). */
  readonly id: string;
  /** Texto da paleta, como está (pt-BR). */
  readonly title: string;
  /** Atalho só MOSTRADO (notação do CM, da plataforma do host); a tecla é do keymap do plugin. */
  readonly hotkey?: string;
  run(view: EditorView): boolean;
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

/**
 * Camada do dicionário do usuário (r32b; D-P26-03): `global` = deste computador (nos dados do app,
 * vale em qualquer pasta aberta); `folder` = desta pasta (`.simplemd/dictionaries/*.txt`, viaja com
 * ela). A verificação usa a união das duas.
 */
export type DictionaryLayer = 'global' | 'folder';

/**
 * Resultado de gravar no dicionário: `added` (gravado), `exists` (já estava na camada; nada
 * gravado), `full` (a camada tem 200.000 termos ou o `pessoal.txt` passaria de 10 MiB), `invalid`
 * (fora do formato v1: vazio, `#` no início, mais de 64 caracteres, espaço, caractere de controle ou
 * de formatação invisível), `no-folder` (camada da pasta sem pasta aberta) ou `failed` (leitura ou
 * gravação; a mensagem nunca tem caminho).
 */
export type DictionaryWriteResult =
  | { readonly status: 'added' | 'exists' | 'full' | 'invalid' | 'no-folder' }
  | { readonly status: 'failed'; readonly message: string };

/**
 * Dicionário do usuário visto por um plugin interno (r32b; design-r32 §1): a união da camada global
 * e da camada da pasta aberta, servida pelo app (`apps/desktop/src/state/dictionary.ts`). O plugin
 * nunca vê caminhos nem o texto dos arquivos.
 */
export interface DictionaryHost {
  /**
   * A palavra está na união, comparada em NFC e com a regra de caixa do LanguageTool: igual ou,
   * sem caixa misturada, em minúsculas. Antes da primeira carga, `false`.
   */
  known(word: string): boolean;
  /** Acrescenta a palavra ao `pessoal.txt` da camada (criado se faltar). Nunca rejeita. */
  add(word: string, layer: DictionaryLayer): Promise<DictionaryWriteResult>;
  /**
   * Várias palavras numa gravação só (a migração do `data.json`): tudo ou nada; `rejected` são as
   * fora do formato v1, que não entram. Nunca rejeita.
   */
  addAll(
    words: readonly string[],
    layer: DictionaryLayer,
  ): Promise<DictionaryWriteResult & { readonly rejected: readonly string[] }>;
  /** Avisa a cada mudança (carga, recarga, gravação); a primeira assinatura começa a carga. */
  subscribe(listener: () => void): () => void;
}

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
     * [DA-R7-13] Comandos `problems:*` da paleta: privilégio da UI de diagnósticos compartilhada —
     * lint, LT e corretor offline (`simplemd.spell`, r35a) — na tabela de `contextFor`; para os
     * demais fica `undefined`.
     */
    readonly problems?: (commands: ProblemsCommands) => Extension;
    /** `EditorView.announce` na view principal (região polida do CM; arch-ux §7.1). */
    announce(text: string): void;
    /**
     * O view do grupo do editor com foco no app (r39c): segue o grupo com foco do store mesmo com o
     * foco do DOM fora dos editores; `subscribe` avisa quando ele pode ter mudado (montagem,
     * desmontagem, troca de grupo). Ausente num host sem grupos (testes): o plugin segue o foco do
     * DOM.
     */
    readonly focusedView?: {
      get(): EditorView | null;
      subscribe(listener: () => void): () => void;
    };
  };
  /** Slot `vim` da barra de status: só o registro do Vim o recebe (privilégio). */
  readonly vimStatus?: StatusSlot<VimStatus>;
  /** Slot `lt` da barra de status + ações do M2: só o registro do LanguageTool o recebe. */
  readonly ltStatus?: LtStatusSlot;
  /**
   * [JEV D-R7-M05] Comandos da paleta com título exato: privilégio por id (tabela de
   * `contextFor`); para os demais fica `undefined`. Ids fora de `<pluginId>:` lançam.
   */
  readonly palette?: (commands: readonly InternalCommand[]) => Extension;
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
  /**
   * Dicionário do usuário (r32b): só o registro do LanguageTool o compõe, no próprio arquivo de
   * registro, com `services.dictionary` (DA-R7-26); para os demais fica `undefined`.
   */
  readonly dictionary?: DictionaryHost;
  /**
   * Cobertura de línguas do corretor offline, só leitura (r35b; D-R35-1, D-R35-6): só o registro do
   * LanguageTool a compõe, com `services.spellCoverage` (DA-R7-26); para os demais fica `undefined`.
   * Na nota coberta, a ortografia é do corretor e o LanguageTool a deixa de fora.
   */
  readonly spellCoverage?: SpellCoverage;
}
