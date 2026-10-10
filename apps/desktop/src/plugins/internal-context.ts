import { EditorView } from '@codemirror/view';
import {
  contextAction,
  escapeHandler,
  interactFacet,
  internalCommandsFacet,
  problemsCommandsFacet,
} from '@simplemd/core';
import type {
  ConfigFileRead,
  InternalCommand,
  InternalHostContext,
  LtMenuAction,
  LtStatus,
  ProblemsCommands,
  VimStatus,
} from '@simplemd/plugin-api/internal/host';
import type { LanguageToolTransport } from '@simplemd/plugin-api/internal/languagetool';
import type { VaultConfigFile } from '@simplemd/vault';
import type { StatusBarStore } from '../app/status-bar';

/**
 * Menor privilégio por plugin interno (arch-frontend r7 §3.2): o que cada registro recebe além do
 * contexto comum. Fica aqui, revisável num lugar só; um descritor não concede nada a si mesmo.
 */
export interface InternalPrivileges {
  /** Arquivos de configuração do vault que o plugin pode ler (lista fechada do backend). */
  readonly files?: readonly VaultConfigFile[];
  readonly languageTool?: true;
  readonly status?: 'vim' | 'lt';
  /** Comandos `problems:*` da paleta (DA-R7-13): só a UI compartilhada de lint/LT. */
  readonly problems?: true;
  /** Ordem do alvo de "Interagir com o elemento sob o cursor" (W2 10 → W3 20; DA-R7-27). */
  readonly interactOrder?: number;
  /** Comandos da paleta com título exato e tecla reservada (JEV D-R7-M05, `host.palette`). */
  readonly palette?: true;
}

const PRIVILEGES: Readonly<Record<string, InternalPrivileges>> = {
  'simplemd.tasks': { interactOrder: 20 },
  'simplemd.vim': { status: 'vim' },
  'simplemd.lint': {
    files: ['.markdownlint.json', '.markdownlint.jsonc'],
    problems: true,
    interactOrder: 10,
  },
  'simplemd.latex-snippets': { files: ['.simplemd/latex-snippets.json'] },
  'simplemd.languagetool': { languageTool: true, status: 'lt', problems: true, interactOrder: 10 },
};

/** Alvo de interação de um plugin sem ordem declarada: depois de W2/W3, antes do núcleo (30). */
const DEFAULT_INTERACT_ORDER = 25;

/** O que o app entrega para montar o contexto de um plugin interno. */
export interface InternalContextDeps {
  readonly platform: 'mac' | 'other';
  readonly statusBar: StatusBarStore;
  /** O `EditorView` principal montado (anúncios); `null` sem editor. */
  view(): EditorView | null;
  readonly options: (pluginId: string) => InternalHostContext['options'];
  openExternal(url: string): void;
  /** Leitura da lista fechada pelo provider (`null` sem pasta aberta). */
  readConfigFile(name: string): Promise<ConfigFileRead | null>;
  watchConfigFiles(
    allowed: readonly VaultConfigFile[],
    listener: (name: string) => void,
  ): () => void;
  readonly languageTool: LanguageToolTransport;
}

/**
 * Contexto de UM plugin interno (D-R7-F03): o comum + só os privilégios da tabela. Usado pelo
 * runtime (`contextFor`) e pelo teste de conflitos de atalhos (o mesmo contexto da produção).
 */
export function createInternalHostContext(
  id: string,
  deps: InternalContextDeps,
  /** A tabela de produção; outra só em teste. */
  privilegeTable: Readonly<Record<string, InternalPrivileges>> = PRIVILEGES,
): InternalHostContext {
  const privileges = privilegeTable[id] ?? {};
  const { files } = privileges;
  const { statusBar } = deps;
  return {
    pluginId: id,
    platform: deps.platform,
    editor: {
      contextAction: (slot, action) => contextAction(slot, action),
      interact: (run) =>
        interactFacet.of({ order: privileges.interactOrder ?? DEFAULT_INTERACT_ORDER, run }),
      escape: (owner, run) => escapeHandler(owner, run),
      ...(privileges.problems
        ? { problems: (commands: ProblemsCommands) => problemsCommandsFacet.of(commands) }
        : {}),
      announce: (text) => deps.view()?.dispatch({ effects: EditorView.announce.of(text) }),
    },
    ...(privileges.status === 'vim'
      ? {
          vimStatus: {
            set: (value: VimStatus) => statusBar.set('vim', value),
            clear: () => statusBar.set('vim', null),
          },
        }
      : {}),
    ...(privileges.status === 'lt'
      ? {
          ltStatus: {
            set: (value: LtStatus) => statusBar.set('lt', value),
            clear: () => statusBar.set('lt', null),
            onAction: (listener: (action: LtMenuAction) => void) => statusBar.onLtAction(listener),
          },
        }
      : {}),
    ...(privileges.palette
      ? {
          palette: (commands: readonly InternalCommand[]) => {
            const foreign = commands.find((command) => !command.id.startsWith(`${id}:`));
            if (foreign)
              throw new Error(`${id}: comando de paleta fora do prefixo “${id}:”: ${foreign.id}`);
            return internalCommandsFacet.of(commands);
          },
        }
      : {}),
    options: deps.options(id),
    links: { openExternal: (url) => deps.openExternal(url) },
    ...(files
      ? {
          files: {
            read: async (name: string): Promise<ConfigFileRead> =>
              files.some((allowed) => allowed === name)
                ? ((await deps.readConfigFile(name)) ?? { error: 'missing' })
                : { error: 'missing' },
            onChange: (listener: (name: string) => void) => deps.watchConfigFiles(files, listener),
          },
        }
      : {}),
    ...(privileges.languageTool ? { languageTool: deps.languageTool } : {}),
  };
}
