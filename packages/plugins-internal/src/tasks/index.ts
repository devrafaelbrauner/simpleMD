import type { EditorState } from '@codemirror/state';
import type { PluginAPI } from '@simplemd/plugin-api';
import type { InternalHostContext } from '@simplemd/plugin-api/internal/host';
import type { TasksCatalog } from '@simplemd/plugin-api/internal/tasks-catalog';
import { createQuerySnapshotRenderer, type QuerySnapshotRenderer } from './render';
import { QueryController, queryWidgetExtension } from './widget';

/** Módulo devolvido ao registro `apps/desktop/src/plugins/internal/tasks.ts` (S9a). */
export interface TasksPluginModule {
  /** O mesmo `activate` (um argumento) dos plugins externos (AC-6.9 r2). */
  readonly default: (api: PluginAPI) => () => void;
  /** Instantâneo das consultas na exportação (AC-EX.4), sobre o catálogo desta closure. */
  readonly renderQueryHtml: QuerySnapshotRenderer;
}

/**
 * Plugin interno "Tarefas e consultas" (`simplemd.tasks`, I-9). O catálogo privado chega só por
 * closure do registro (D-R7-F02, AC-I9.1): não passa pelo `api` nem por `window`. Liga a semântica
 * de conclusão (privilégio só deste plugin), o widget W3 dos blocos ```` ```tasks ````/
 * ```` ```dataview ```` e o alvo de "Interagir com o elemento sob o cursor" (`Mod-Shift-Enter`).
 */
export function createTasksPlugin(
  host: InternalHostContext,
  catalog: TasksCatalog,
  notePathOf: (state: EditorState) => string | null,
): TasksPluginModule {
  return {
    default(api) {
      const controller = new QueryController({
        catalog,
        host,
        notePathOf,
        now: () => new Date(),
      });
      const widget = queryWidgetExtension(controller);
      const semantics = host.editor.taskSemantics?.({
        recordDoneDate: () => host.options.get<boolean>('recordDoneDate') !== false,
      });
      api.registerEditorExtension({
        source: [
          widget.extension,
          host.editor.interact((view, pos) => controller.interact(view, pos)),
          ...(semantics ? [semantics] : []),
        ],
      });
      return () => controller.dispose();
    },
    renderQueryHtml: createQuerySnapshotRenderer(catalog),
  };
}
