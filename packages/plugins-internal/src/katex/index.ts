import type { PluginAPI } from '@simplemd/plugin-api';
import { katexExtension } from './decorate';

/**
 * Plugin interno "Fórmulas KaTeX" (etapa 7, R-7.3): `$…$` em linha e blocos `$$`. Só a API v1
 * (`registerEditorExtension`), os módulos do host e a própria biblioteca, carregada sob demanda
 * (R-7.1, AC-7.12).
 */
export function activate(api: PluginAPI): void {
  api.registerEditorExtension({ source: katexExtension });
}

export default activate;
