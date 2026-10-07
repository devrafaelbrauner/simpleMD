import type { PluginAPI } from '@simplemd/plugin-api';
import { mermaidExtension } from './decorate';

/**
 * Plugin interno "Diagramas Mermaid" (etapa 7, R-7.2): cercas ```mermaid viram SVG. Só a API v1
 * (`registerEditorExtension`), os módulos do host e a própria biblioteca, carregada quando um
 * diagrama fica visível (R-7.1, AC-7.12).
 */
export function activate(api: PluginAPI): void {
  api.registerEditorExtension({ source: mermaidExtension });
}

export default activate;
