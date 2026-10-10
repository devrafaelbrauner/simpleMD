import type { Extension } from '@codemirror/state';
import { pendingTableCommands } from './commands';
import { tableContextAction, tableKeymap, tablePrefetch } from './keys';

export {
  runTableCommand,
  TABLE_COMMANDS,
  TABLE_TEXT,
  tableAt,
  tableNoticeFacet,
  type TableCommandId,
  type TableCommandSpec,
  type TableContext,
} from './commands';
export { loadTableEngine, prefetchTableEngine, tableEngine } from './engine';

/**
 * I-3 (arch-frontend r7 §7): célula da cadeia de contexto (slot `table`), Enter/Shift-Enter e
 * `Mod-Shift-F` na tabela, pré-carga do motor e a fila de comandos pedidos antes da carga. Entra na
 * pilha do markdown pelo ponto de registro `keys/index.ts` (ST → S3).
 */
export const tablesExtension: Extension = [
  tableContextAction,
  tableKeymap,
  tablePrefetch,
  pendingTableCommands,
];
