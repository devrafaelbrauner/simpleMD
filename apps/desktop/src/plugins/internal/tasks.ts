import { loadTaskCompletion, noteContext, taskToggleFacet } from '@simplemd/core';
import type { InternalHostContext } from '@simplemd/plugin-api/internal/host';
import type { TasksCatalog } from '@simplemd/plugin-api/internal/tasks-catalog';
import { defineInternalPlugin } from './define';

/**
 * Tarefas e consultas (I-9; D-R7-P01 ligado). O descritor é minúsculo; o plugin, a conclusão de
 * R-I9.7 (`complete.ts` + `recurrence.ts`) e o catálogo privado chegam só no `load` (pedaços sob
 * demanda, NFR-54). Este é o ÚNICO arquivo do app que alcança o catálogo privado (AC-I9.1, regra
 * de lint) e o único que compõe `host.editor.taskSemantics` (arch-frontend r7 §3.3, D-R7-F02).
 */
export default defineInternalPlugin({
  id: 'simplemd.tasks',
  name: 'Tarefas e consultas',
  description:
    'Caixas de tarefa com data de conclusão e blocos tasks e dataview que listam tarefas e notas desta pasta.',
  defaultEnabled: true,
  order: 40,
  options: [
    { key: 'recordDoneDate', kind: 'boolean', label: 'Registrar data de conclusão', default: true },
  ],
  async load({ host, services }) {
    const [plugin, completion, catalogModule, querySource] = await Promise.all([
      import('@simplemd/plugins-internal/tasks'),
      loadTaskCompletion(),
      import('../../catalog/tasks-catalog'),
      import('../../export/query-source'),
    ]);
    const { store } = services;
    const tasksHost: InternalHostContext = {
      ...host,
      editor: {
        ...host.editor,
        taskSemantics: ({ recordDoneDate }) =>
          taskToggleFacet.of(
            completion.taskCompletionSemantics({
              recordDoneDate,
              onUnsupportedRule: (rule) =>
                store.getState().pushNotice({
                  kind: 'info',
                  level: 'warn',
                  notice: 'query',
                  text: catalogModule.TASKS_CATALOG_TEXT.unsupported(rule),
                  key: 'query',
                }),
            }),
          ),
      },
    };
    // A interface privada existe só nesta closure (AC-I9.1): o plugin a recebe como argumento e a
    // exportação recebe só o renderizador do instantâneo (AC-EX.4).
    const catalog: TasksCatalog = catalogModule.createTasksCatalog({
      vault: services.platform.vault,
      store,
      registry: services.registry,
      catalog: services.catalog,
      sync: services.sync,
      view: () => services.editor.view,
      completion,
    });
    const tasks = plugin.createTasksPlugin(
      tasksHost,
      catalog,
      (state) => state.facet(noteContext).path,
    );
    querySource.setQuerySnapshotRenderer(tasks.renderQueryHtml);
    return tasks;
  },
});
