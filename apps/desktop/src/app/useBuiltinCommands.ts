import { AI_COMMAND_LABELS, AI_COMMANDS, AI_LANGUAGES } from '@simplemd/ai';
import {
  interactWithElement,
  internalCommandsFacet,
  openLinkAtCursor,
  problemsCommandsFacet,
  runTableCommand,
  TABLE_COMMANDS,
  TAB_FOCUS_HOTKEY,
  TAB_FOCUS_TEXT,
  toggleTabFocusAnnounced,
  toggleTaskCommand,
  type InternalCommand,
} from '@simplemd/core';
import { FOLDER_COLOR_IDS, isFolderColorId, resolveFolderColor } from '@simplemd/themes';
import {
  FOLDER_COLOR_LABELS,
  FOLDER_COLOR_SPOKEN,
  isMac,
  type CodeMirrorEditorHandle,
} from '@simplemd/ui';
import { useEffect, useState, type RefObject } from 'react';
import { useStore } from 'zustand';
import type { AppController } from './controller';
import { closeTab, toggleSidePanel } from './focus';

/**
 * Comandos embutidos da paleta (arch-ux r2 §3.6, r7 §3.7; ids = `data-command-id`): `app:`, depois
 * os do editor (r7), a exportação (etapa 10; `Mod-P` = PDF) e a IA. "IA: Traduzir seleção" mostra
 * o idioma configurado (re-registrado quando muda).
 */
export function useBuiltinCommands(
  app: AppController,
  editor: RefObject<CodeMirrorEditorHandle | null>,
): void {
  const language = useStore(app.store, (s) => s.ai.language);
  const captureTab = useStore(app.store, (s) => s.captureTab);
  const hasProblems = useProblemsFacet(app);
  const internalCommands = useInternalCommands(app);
  useEffect(() => {
    const { commands } = app.plugins;
    const state = () => app.store.getState();
    const vaultOpen = () =>
      state().vaultStatus === 'open' ? (true as const) : { reason: 'Abra uma pasta primeiro.' };
    const offs = [
      commands.register({
        id: 'app:open-vault',
        title: 'Abrir pasta…',
        source: 'builtin',
        hotkey: 'Mod-o',
        run: () => app.sync.openVault(state().vaultStatus === 'open' ? 'shell' : 'welcome'),
      }),
      commands.register({
        id: 'app:new-note',
        title: 'Nova nota…',
        source: 'builtin',
        hotkey: 'Mod-n',
        isEnabled: vaultOpen,
        run: () => app.sync.openNewNote(),
      }),
      commands.register({
        id: 'app:settings',
        title: 'Configurações',
        source: 'builtin',
        hotkey: 'Mod-,',
        run: () => app.store.setState({ settingsOpen: true, settingsSection: 'appearance' }),
      }),
      // r7 R-X7.1 (arch-ux §3.7): abre o L2 direto na seção "Editor".
      commands.register({
        id: 'app:settings-editor',
        title: 'Configurações do editor',
        source: 'builtin',
        run: () => app.store.setState({ settingsOpen: true, settingsSection: 'editor' }),
      }),
      commands.register({
        id: 'app:plugins',
        title: 'Plugins…',
        source: 'builtin',
        run: () => app.store.setState({ settingsOpen: true, settingsSection: 'plugins' }),
      }),
      commands.register({
        id: 'app:close-tab',
        title: 'Fechar aba',
        source: 'builtin',
        hotkey: 'Mod-w',
        isEnabled: () => (state().activeId ? true : { reason: 'Nenhuma aba aberta.' }),
        run: () => {
          const id = state().activeId;
          if (id) void closeTab(app, editor, id);
        },
      }),
      commands.register({
        id: 'app:toggle-side-panel',
        title: 'Mostrar ou ocultar o painel lateral',
        source: 'builtin',
        hotkey: 'Mod-Shift-l',
        isEnabled: vaultOpen,
        run: () => toggleSidePanel(app, editor, 'key'),
      }),
      ...(
        [
          ['app:show-catalog', 'Mostrar catálogo', 'catalog'],
          ['app:show-toc', 'Mostrar sumário', 'toc'],
          ['app:show-properties', 'Mostrar propriedades', 'properties'],
          ['app:show-links', 'Mostrar links', 'links'],
          ['app:show-chat', 'Abrir chat IA', 'chat'],
        ] as const
      ).map(([id, title, panel]) =>
        commands.register({
          id,
          title,
          source: 'builtin',
          isEnabled: vaultOpen,
          // SPN-PALETTE-OPEN: abre o painel nessa aba e leva o foco até ela.
          run: () => {
            app.store.setState({ sidePanelOpen: true, sidePanelTab: panel });
            requestAnimationFrame(() =>
              document
                .querySelector<HTMLElement>('#side-panel [role="tab"][aria-selected="true"]')
                ?.focus(),
            );
          },
        }),
      ),
      // Exportação (R-10.1, STR-114): as mesmas ações do menu "Exportar"; sem aba, o motivo STR-115.
      ...(
        [
          ['md', 'Exportar como Markdown…', undefined],
          ['html', 'Exportar como HTML…', undefined],
          ['pdf', 'Exportar como PDF…', 'Mod-p'],
        ] as const
      ).map(([kind, title, hotkey]) =>
        commands.register({
          id: `export:${kind}`,
          title,
          source: 'builtin',
          ...(hotkey ? { hotkey } : {}),
          isEnabled: () => app.exporter.enabled(),
          run: () => app.exporter.start(kind),
        }),
      ),
      // Comandos sobre a seleção (R-11.8, STR-132): o resultado vai para o cartão C5.
      ...AI_COMMANDS.map((command) =>
        commands.register({
          id: `ai:${command}`,
          title: AI_COMMAND_LABELS[command],
          source: 'builtin',
          ...(command === 'translate'
            ? { detail: `para ${AI_LANGUAGES.find((l) => l.id === language)?.label ?? 'English'}` }
            : {}),
          isEnabled: () => app.ai.commandEnabled(),
          run: () => void app.ai.runCommand(command),
        }),
      ),
      // r7 I-1 (arch-ux §3.7, STR-142): comandos do núcleo sobre o editor principal; as teclas
      // (`Alt-Enter`, `Mod-L`, `Mod-Shift-Enter`) são do keymap do editor, aqui só aparecem.
      ...(
        [
          ['link:open-under-cursor', 'Abrir link sob o cursor', 'Alt-Enter', openLinkAtCursor],
          ['task:toggle', 'Alternar tarefa', 'Mod-l', toggleTaskCommand],
          [
            'editor:interact',
            'Interagir com o elemento sob o cursor',
            'Mod-Shift-Enter',
            interactWithElement,
          ],
        ] as const
      ).map(([id, title, hotkey, command]) =>
        commands.register({
          id,
          title,
          source: 'builtin',
          hotkey,
          isEnabled: () => (state().activeId ? true : { reason: 'Abra uma nota primeiro.' }),
          run: () => {
            const view = app.plugins.editor.view;
            if (view) command(view);
          },
        }),
      ),
    ];
    return () => {
      for (const off of offs) off();
    };
  }, [app, editor, language]);

  // r7 R-X7.2 (DA-R7-11, UX-R7-D24): sempre listado; com a chave desligada fica `aria-disabled` com
  // o motivo e não faz nada. A tecla (⌥⇧M / Ctrl+M) só existe — e só aparece — com a chave ligada.
  useEffect(
    () =>
      app.plugins.commands.register({
        id: 'editor:toggle-tab-focus',
        title: TAB_FOCUS_TEXT.command,
        source: 'builtin',
        ...(captureTab ? { hotkey: TAB_FOCUS_HOTKEY[isMac ? 'mac' : 'other'] } : {}),
        isEnabled: () => {
          if (!app.store.getState().captureTab) return { reason: TAB_FOCUS_TEXT.disabledReason };
          return app.store.getState().activeId ? true : { reason: 'Abra uma nota primeiro.' };
        },
        run: () => {
          const view = app.plugins.editor.view;
          if (view && app.store.getState().captureTab) toggleTabFocusAnnounced(view);
        },
      }),
    [app, captureTab],
  );

  // r12 S4 (D-R12-F3/F5; arch-ux F1–F4): "Pasta: definir cor…" e "Pasta: remover cor" existem só
  // com uma pasta focada no explorador (arquivo não conta, AC-12.3). A cor vale no mesmo render
  // (pasta, herdeiras e abas) e o anúncio vai para a região do explorador (D-R12-F4).
  useEffect(() => {
    const { commands } = app.plugins;
    const focusedFolder = (): string | null => {
      const { focusedPath, entries } = app.store.getState();
      const isFolder = entries.some((entry) => entry.kind === 'dir' && entry.path === focusedPath);
      return isFolder ? focusedPath : null;
    };
    const offs = [
      commands.register({
        id: 'app:folder-set-color',
        title: 'Pasta: definir cor…',
        source: 'builtin',
        get detail() {
          const path = focusedFolder();
          return path === null ? undefined : `pasta “${path}”`;
        },
        isVisible: () => focusedFolder() !== null,
        step: () => {
          const path = focusedFolder() ?? '';
          const name = path.slice(path.lastIndexOf('/') + 1);
          const current = app.store.getState().folderColors.get(path);
          return {
            label: `Cor para “${name}”`,
            placeholder: `Cor para “${name}”…`,
            ...(current ? { active: current } : {}),
            options: FOLDER_COLOR_IDS.map((id) => ({
              id,
              label: FOLDER_COLOR_LABELS[id],
              swatch: id,
              ...(id === current ? { detail: 'cor atual' } : {}),
            })),
            run: (id) => {
              if (!isFolderColorId(id)) return;
              app.settings.setFolderColor(path, id);
              app.store.setState({
                explorerLive: `Pasta “${name}”: cor ${FOLDER_COLOR_SPOKEN[id]}.`,
              });
            },
          };
        },
        // Sem a paleta (id chamado direto): abre a paleta neste comando, que leva ao 2º passo.
        run: () => app.store.setState({ paletteOpen: true, palettePrefill: 'Pasta: definir cor' }),
      }),
      commands.register({
        id: 'app:folder-remove-color',
        title: 'Pasta: remover cor',
        source: 'builtin',
        get detail() {
          const path = focusedFolder();
          return path === null ? undefined : `pasta “${path}”`;
        },
        isVisible: () => focusedFolder() !== null,
        // D-R12-U2: sem cor própria fica desabilitado com o motivo (herdada: de onde ela vem).
        isEnabled: () => {
          const path = focusedFolder();
          const { folderColors } = app.store.getState();
          if (path !== null && folderColors.has(path)) return true;
          const inherited = path === null ? null : resolveFolderColor(folderColors, `${path}/`);
          return {
            reason: inherited
              ? `A cor vem de “${inherited.folder}”.`
              : 'Esta pasta não tem cor própria.',
          };
        },
        run: () => {
          const path = focusedFolder();
          if (path === null || !app.store.getState().folderColors.has(path)) return;
          app.settings.removeFolderColor(path);
          app.store.setState({
            explorerLive: `Pasta “${path.slice(path.lastIndexOf('/') + 1)}”: sem cor própria.`,
          });
        },
      }),
    ];
    return () => {
      for (const off of offs) off();
    };
  }, [app]);

  // r7 S3 (R-I3.1, arch-ux §3.7, UX-R7-D23): os 22 "Tabela: …" sempre habilitados com uma aba
  // aberta; fora de tabela ou em tabela aninhada o próprio comando mostra o aviso STR-155. Atalhos
  // mostrados = teclas ligadas no editor (`Mod-Shift-F`, `Mod-Alt-→/←`, Enter na tabela).
  useEffect(() => {
    const offs = TABLE_COMMANDS.map((spec) =>
      app.plugins.commands.register({
        id: `table:${spec.id}`,
        title: spec.title,
        source: 'builtin',
        ...(spec.hotkey ? { hotkey: spec.hotkey } : {}),
        isEnabled: () =>
          app.store.getState().activeId ? true : { reason: 'Abra uma nota primeiro.' },
        run: () => {
          const view = app.plugins.editor.view;
          if (view) runTableCommand(view, spec.id);
        },
      }),
    );
    return () => {
      for (const off of offs) off();
    };
  }, [app]);

  // DA-R7-13 (D-R7-ST-01): "Mostrar problemas" / F8 / Shift-F8 só existem com lint ou LT ligado
  // (a facet registrada pela UI compartilhada de diagnósticos); o app não importa `@codemirror/lint`.
  useEffect(() => {
    if (!hasProblems) return;
    const run = (action: 'openPanel' | 'next' | 'prev') => () => {
      const view = app.plugins.editor.view;
      const problems = view?.state.facet(problemsCommandsFacet);
      if (view && problems) problems[action](view);
    };
    const offs = (
      [
        ['problems:panel', 'Mostrar problemas', 'Mod-Shift-m', 'openPanel'],
        ['problems:next', 'Ir para o próximo problema', 'F8', 'next'],
        ['problems:prev', 'Ir para o problema anterior', 'Shift-F8', 'prev'],
      ] as const
    ).map(([id, title, hotkey, action]) =>
      app.plugins.commands.register({ id, title, source: 'builtin', hotkey, run: run(action) }),
    );
    return () => {
      for (const off of offs) off();
    };
  }, [app, hasProblems]);

  // JEV D-R7-M05: comandos dos plugins internos com título exato da UX (`host.palette`), listados
  // só enquanto o plugin que os declara está ligado; o atalho mostrado é a tecla do keymap dele.
  // Um id já registrado (comando v1 do mesmo plugin, ou repetido na facet) é pulado com aviso no
  // console: o efeito nunca lança (sem error boundary, lançar desmontaria o app; CR-PAL-01).
  useEffect(() => {
    const offs: (() => void)[] = [];
    for (const command of internalCommands) {
      if (app.plugins.commands.get(command.id)) {
        console.warn('[simplemd] comando de paleta repetido, ignorado:', command.id);
        continue;
      }
      offs.push(
        app.plugins.commands.register({
          id: command.id,
          title: command.title,
          source: 'plugin',
          pluginId: command.id.slice(0, command.id.indexOf(':')),
          ...(command.hotkey ? { hotkey: command.hotkey } : {}),
          isEnabled: () =>
            app.store.getState().activeId ? true : { reason: 'Abra uma nota primeiro.' },
          run: () => {
            const view = app.plugins.editor.view;
            if (view) command.run(view);
          },
        }),
      );
    }
    return () => {
      for (const off of offs) off();
    };
  }, [app, internalCommands]);
}

/**
 * A facet dos comandos de diagnósticos está no editor (reavaliado a cada aplicação dos plugins e a
 * cada montagem/desmontagem do view).
 */
function useProblemsFacet(app: AppController): boolean {
  const assembly = app.plugins.editor;
  const [has, setHas] = useState(false);
  useEffect(() => {
    const update = () => setHas(assembly.view?.state.facet(problemsCommandsFacet) != null);
    update();
    return assembly.onApplied(update);
  }, [assembly]);
  return has;
}

const NO_COMMANDS: readonly InternalCommand[] = [];

/** Comandos de `internalCommandsFacet` do editor principal (mesma reavaliação da facet acima). */
function useInternalCommands(app: AppController): readonly InternalCommand[] {
  const assembly = app.plugins.editor;
  const [commands, setCommands] = useState(NO_COMMANDS);
  useEffect(() => {
    const update = () =>
      setCommands(assembly.view?.state.facet(internalCommandsFacet) ?? NO_COMMANDS);
    update();
    return assembly.onApplied(update);
  }, [assembly]);
  return commands;
}
