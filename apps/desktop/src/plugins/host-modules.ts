import * as autocomplete from '@codemirror/autocomplete';
import * as language from '@codemirror/language';
import * as state from '@codemirror/state';
import * as view from '@codemirror/view';
import type { HostModules } from '@simplemd/plugin-api/runtime';

/**
 * Módulos do host (R-6.8, D-12; contrato de plugins v1): os 4 especificadores que um plugin pode
 * importar resolvem para as MESMAS instâncias do app (uma segunda cópia do `@codemirror/state`
 * quebraria `instanceof`). Só CodeMirror; nada do Tauri.
 */
export const HOST_MODULE_NAMESPACES: HostModules = {
  '@codemirror/state': state,
  '@codemirror/view': view,
  '@codemirror/language': language,
  '@codemirror/autocomplete': autocomplete,
};
