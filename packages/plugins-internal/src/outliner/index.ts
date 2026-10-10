import { Prec, type Extension } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import type { PluginAPI } from '@simplemd/plugin-api';
import type { InternalCommand, InternalHostContext } from '@simplemd/plugin-api/internal/host';
import type { OutlinerContext } from './context';
import { contentKeys } from './features/content-keys';
import { dragAndDropExtension } from './features/drag-and-drop';
import { enterBehaviour } from './features/enter';
import { foldAll, foldingExtension, setFold, unfoldAll } from './features/folding';
import { guidesExtension } from './features/guides';
import { moveKeys, movementBindings, runMovement } from './features/movement';
import { selectionsBehaviour } from './features/selections';
import { Parser } from './model/parser';
import { OperationPerformer } from './model/perform';
import { defaultSettings, type OutlinerSettings } from './model/settings';
import { OUTLINER_TEXT } from './text';
import { outlinerTheme } from './theme';

/** O que o outliner usa do contexto do host (o registro entrega o contexto inteiro). */
export type OutlinerHost = Pick<
  InternalHostContext,
  'pluginId' | 'platform' | 'editor' | 'palette'
>;

/** Contexto de uma ativação (as partes compartilham parser, executor e ajustes). */
export function createOutlinerContext(
  host: OutlinerHost,
  settings: OutlinerSettings = defaultSettings(),
): OutlinerContext {
  const parser = new Parser(settings);
  return {
    settings,
    parser,
    performer: new OperationPerformer(parser),
    platform: host.platform,
    announce: (text) => host.editor.announce(text),
  };
}

/** Comandos "Lista: …" da paleta (STR-174; ids `simplemd.outliner:*`, arch-ux §3.7). */
export function outlinerCommands(ctx: OutlinerContext, pluginId: string): InternalCommand[] {
  const keys = moveKeys(ctx.platform);
  return [
    {
      id: `${pluginId}:move-up`,
      title: OUTLINER_TEXT.moveUp,
      hotkey: keys.up,
      run: (view) => runMovement(ctx, view, 'move-up'),
    },
    {
      id: `${pluginId}:move-down`,
      title: OUTLINER_TEXT.moveDown,
      hotkey: keys.down,
      run: (view) => runMovement(ctx, view, 'move-down'),
    },
    {
      id: `${pluginId}:indent`,
      title: OUTLINER_TEXT.indent,
      hotkey: 'Mod-]',
      run: (view) => runMovement(ctx, view, 'indent'),
    },
    {
      id: `${pluginId}:outdent`,
      title: OUTLINER_TEXT.outdent,
      hotkey: 'Mod-[',
      run: (view) => runMovement(ctx, view, 'outdent'),
    },
    {
      id: `${pluginId}:fold`,
      title: OUTLINER_TEXT.fold,
      run: (view) => setFold(ctx, view, 'fold'),
    },
    {
      id: `${pluginId}:unfold`,
      title: OUTLINER_TEXT.unfold,
      run: (view) => setFold(ctx, view, 'unfold'),
    },
    { id: `${pluginId}:fold-all`, title: OUTLINER_TEXT.foldAll, run: foldAll },
    { id: `${pluginId}:unfold-all`, title: OUTLINER_TEXT.unfoldAll, run: unfoldAll },
  ];
}

/**
 * Todas as extensões do outliner (porte do `obsidian-outliner` 4.10.2, I-7). Teclas de lista em
 * `Prec.highest` (o outliner refina Enter/Backspace/Delete/←/Mod-A antes do `lang-markdown`, arch-ux
 * §6.4); Tab/Shift-Tab e `Mod-]`/`Mod-[` só pela cadeia de contexto (slot `list`, prioridade 10
 * sobre o fallback do núcleo).
 */
export function outlinerExtension(
  host: OutlinerHost,
  ctx = createOutlinerContext(host),
): Extension {
  return [
    outlinerTheme,
    enterBehaviour(ctx),
    Prec.highest(contentKeys(ctx)),
    keymap.of(movementBindings(ctx)),
    host.editor.contextAction('list', {
      priority: 10,
      kinds: ['tab', 'indent'],
      run: (view, dir) => runMovement(ctx, view, dir === 1 ? 'indent' : 'outdent'),
    }),
    selectionsBehaviour(ctx),
    foldingExtension(ctx),
    guidesExtension(ctx),
    dragAndDropExtension(ctx),
    host.palette?.(outlinerCommands(ctx, host.pluginId)) ?? [],
  ];
}

/** Ativação (registro `apps/desktop/src/plugins/internal/outliner.ts`). */
export function activate(api: PluginAPI, host: OutlinerHost): void {
  api.registerEditorExtension({ source: outlinerExtension(host) });
}
