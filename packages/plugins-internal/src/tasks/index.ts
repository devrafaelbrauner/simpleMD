import type { PluginAPI } from '@simplemd/plugin-api';
import type { InternalHostContext } from '@simplemd/plugin-api/internal/host';

/** Módulo devolvido ao registro `apps/desktop/src/plugins/internal/tasks.ts`. */
export interface TasksPluginModule {
  /** O mesmo `activate` (um argumento) dos plugins externos (AC-6.9 r2). */
  readonly default: (api: PluginAPI) => void;
}

/**
 * Plugin interno "Tarefas e consultas" (`simplemd.tasks`, I-9): liga a semântica de conclusão de
 * R-I9.7 (✅ e recorrência) nas caixas e no "Alternar tarefa" do editor — privilégio só deste
 * plugin, composto pelo registro. Desligar o plugin remove a extensão e o editor volta à semântica
 * simples (R-I1.3).
 */
export function createTasksPlugin(host: InternalHostContext): TasksPluginModule {
  return {
    default(api) {
      const semantics = host.editor.taskSemantics?.({
        recordDoneDate: () => host.options.get<boolean>('recordDoneDate') !== false,
      });
      if (semantics) api.registerEditorExtension({ source: semantics });
    },
  };
}
