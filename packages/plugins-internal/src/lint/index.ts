import { forceLinting, linter } from '@codemirror/lint';
import { StateEffect, type Extension } from '@codemirror/state';
import { ViewPlugin, type EditorView } from '@codemirror/view';
import type { PluginAPI } from '@simplemd/plugin-api';
import type { InternalHostContext } from '@simplemd/plugin-api/internal/host';
import { diagnosticsExtension } from '../shared/diagnostics-ui';
import {
  invalidConfigNotice,
  LINT_CONFIG_FILES,
  loadLintConfig,
  type LintConfig,
  type LintConfigFile,
  type LoadedLintConfig,
} from './config';
import { createLintEngine, type EngineDeps } from './engine';
import { DEFAULT_LINT_CONFIG } from './rules';
import { createLintSource } from './source';

/**
 * Plugin interno "Lint de Markdown" (`simplemd.lint`, I-5; desligado por padrão): markdownlint
 * 0.41.1 num worker + `@codemirror/lint` só como estado/painel/navegação, apresentado pela UI
 * compartilhada de diagnósticos (cartão W2, calha, painel W5). Só diagnóstico: nenhuma ação muda
 * o documento (regra 1, R-I5.4). Roda sobre a nota ativa ao abrir e 750 ms depois da última edição
 * (R-I5.1); a configuração `.markdownlint.json(c)` da pasta é relida quando muda (≤ 2 s, R-I5.2).
 */

/** Espera depois da última edição (R-I5.1, NFR-52). */
export const LINT_DELAY_MS = 750;

/** Plano C (thread principal): o aviso "lint lento" só vale para notas acima disto (Q-R7-F04). */
export const SLOW_NOTE_LINES = 2000;

export const SLOW_LINT_NOTICE =
  'Lint lento: este sistema não deixou o lint rodar em segundo plano; em notas com mais de 2.000 linhas a digitação pode travar.';

/** Avisos já mostrados nesta sessão do app (um por arquivo inválido; um de lint lento). */
const noticesShown = new Set<string>();

/** Pede uma rodada nova (configuração mudou) às views abertas. */
const refreshLint = StateEffect.define<null>();

export interface LintPluginOptions {
  /** Costura de teste do motor (worker falso, agenda do plano C). */
  readonly engine?: EngineDeps;
}

export function createLintPlugin(
  host: InternalHostContext,
  options: LintPluginOptions = {},
): { default: (api: PluginAPI) => () => void } {
  return {
    default(api) {
      const views = new Set<EditorView>();
      let active = true;
      let largestDoc = 0;
      const notifyOnce = (key: string, text: string) => {
        if (noticesShown.has(key)) return;
        noticesShown.add(key);
        api.ui.notify(text, 'warn');
      };
      const engine = createLintEngine({
        ...options.engine,
        onIdleFallback: () => {
          options.engine?.onIdleFallback?.();
          if (largestDoc > SLOW_NOTE_LINES) notifyOnce('slow', SLOW_LINT_NOTICE);
        },
      });

      let version = 0;
      let current: Promise<LoadedLintConfig>;
      const read = (name: LintConfigFile) => host.files?.read(name) ?? Promise.resolve(null);
      const load = () => {
        version++;
        current = loadLintConfig(read).then((loaded) => {
          if (loaded.origin.kind === 'invalid')
            notifyOnce(`invalid:${loaded.origin.name}`, invalidConfigNotice(loaded.origin.name));
          return loaded;
        });
        return current;
      };
      load();

      const refresh = () => {
        for (const view of views) {
          view.dispatch({ effects: refreshLint.of(null) });
          forceLinting(view);
        }
      };
      const offFiles = host.files?.onChange((name) => {
        if (!(LINT_CONFIG_FILES as readonly string[]).includes(name)) return;
        void load().then(refresh);
      });

      const source = createLintSource({
        engine,
        config: async () => {
          const at = version;
          const loaded = await current;
          return { config: loaded.config, version: at };
        },
        onEngineError: (config: LintConfig) => {
          if (!active || config === DEFAULT_LINT_CONFIG) return;
          // O markdownlint recusou a configuração da pasta: padrão do app + aviso, como inválido.
          void current.then((loaded) => {
            if (loaded.origin.kind !== 'file') return;
            const name = loaded.origin.name;
            current = Promise.resolve({
              config: DEFAULT_LINT_CONFIG,
              origin: { kind: 'invalid', name },
            });
            version++;
            notifyOnce(`invalid:${name}`, invalidConfigNotice(name));
            refresh();
          });
        },
        openExternal: (url) => host.links.openExternal(url),
      });

      /** Views abertas (recarga da configuração) e a rodada imediata ao abrir a nota. */
      const tracker = ViewPlugin.define((view) => {
        views.add(view);
        largestDoc = Math.max(largestDoc, view.state.doc.lines);
        const timer = setTimeout(() => forceLinting(view), 0);
        return {
          update(update) {
            if (update.docChanged) largestDoc = Math.max(largestDoc, update.state.doc.lines);
          },
          destroy() {
            clearTimeout(timer);
            views.delete(view);
          },
        };
      });

      const extension: Extension = [
        diagnosticsExtension(host),
        linter(source, {
          delay: LINT_DELAY_MS,
          needsRefresh: (update) =>
            update.transactions.some((tr) => tr.effects.some((e) => e.is(refreshLint))),
        }),
        tracker,
      ];
      api.registerEditorExtension({ source: extension });

      return () => {
        offFiles?.();
        active = false;
        engine.dispose();
        views.clear();
      };
    },
  };
}
