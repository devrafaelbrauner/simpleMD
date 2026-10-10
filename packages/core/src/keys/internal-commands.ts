import { Facet } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';

/**
 * Comandos de paleta dos plugins INTERNOS (JEV D-R7-M05): título exato da UX (STR-xxx, sem o
 * prefixo do nome do plugin que a API v1 põe) e atalho que pode ser uma tecla reservada do app. O
 * plugin declara pelo `host.palette` (privilégio por id em `internal-context.ts`); o app lê esta
 * facet do editor principal e registra os comandos na paleta enquanto ela estiver presente, isto
 * é, só com o plugin ligado (mesmo padrão de `problemsCommandsFacet`).
 */
export interface InternalCommand {
  /** Id completo da paleta: `<pluginId>:<id>` (ex.: `simplemd.outliner:move-up`). */
  readonly id: string;
  /** Texto da paleta, como está (pt-BR). */
  readonly title: string;
  /**
   * Atalho MOSTRADO na paleta (notação do CodeMirror, já da plataforma do host). A tecla é ligada
   * pelo keymap do próprio plugin; a paleta não liga nada.
   */
  readonly hotkey?: string;
  run(view: EditorView): boolean;
}

/** Todos os comandos declarados, na ordem das extensões (vazio = nenhum plugin com comandos). */
export const internalCommandsFacet = Facet.define<
  readonly InternalCommand[],
  readonly InternalCommand[]
>({
  combine: (values) => values.flat(),
});
