import type { PluginAPI } from '@simplemd/plugin-api';
import { calcExtension } from './decorate';

/**
 * Plugin interno "Cálculo" (etapa 7, R-7.4): `=2+3` vira `5`. Usa só a API v1
 * (`registerEditorExtension`) e os módulos do host — prova de suficiência da API (R-7.1). O mesmo
 * código, empacotado, é `plugins-examples/calc` (R-7.5).
 */
export function activate(api: PluginAPI): void {
  api.registerEditorExtension({ source: calcExtension });
}

export default activate;
