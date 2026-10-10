import type { Extension } from '@codemirror/state';
import { keymap, ViewPlugin } from '@codemirror/view';
import type { PluginAPI } from '@simplemd/plugin-api';
import type { InternalCommand, InternalHostContext } from '@simplemd/plugin-api/internal/host';
import { diagnosticsExtension } from '../shared/diagnostics-ui';
import { LtChecker, type LtClock, type LtConfig } from './checker';
import { ltField } from './field';
import { DEFAULT_LANGUAGE } from './language';
import { ltLinter, repaint, type LtActions } from './present';
import { RULE_ID } from './response';

/**
 * Plugin interno "Ortografia e gramática (LanguageTool)" (r7 I-8; arch-frontend §10.5), desligado
 * por padrão. Fala só com o transporte nativo do host (`host.languageTool`: `lt_languages`,
 * `lt_check`, `lt_cancel`; variante N — nada de `fetch` no webview). Diagnósticos pela UI
 * compartilhada de S5; estado na barra de status (`host.ltStatus`) com o menu M2; comando
 * "Verificar ortografia e gramática agora" (`Mod-Shift-O`) pela paleta (`host.palette`).
 */

export const CHECK_NOW_ID = 'simplemd.languagetool:check-now';
export const CHECK_NOW_TITLE = 'Verificar ortografia e gramática agora';
export const CHECK_NOW_KEY = 'Mod-Shift-o';
/** R-I8.5: teto do dicionário pessoal (palavras). */
export const MAX_DICTIONARY_WORDS = 10_000;

const systemClock: LtClock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as number),
};

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

/**
 * `activate` do plugin para o contexto do host (o registro chama com o `host` deste plugin).
 * `clock` só muda nos testes (relógio falso, AC-I8.4/6/7).
 */
export function createLanguageToolPlugin(
  host: InternalHostContext,
  clock: LtClock = systemClock,
): (api: PluginAPI) => () => void {
  return (api) => {
    const transport = host.languageTool;
    if (!transport) throw new Error('simplemd.languagetool: transporte do LanguageTool ausente');
    const config = (): LtConfig => ({
      mode: host.options.get<string>('mode') === 'manual' ? 'manual' : 'auto',
      language: host.options.get<string | undefined>('language') ?? DEFAULT_LANGUAGE,
      disabledRules: stringList(host.options.get<unknown>('disabledRules')).filter((id) =>
        RULE_ID.test(id),
      ),
      dictionary: stringList(api.settings.get<unknown>('dictionary')),
    });
    const checker = new LtChecker({
      transport,
      clock,
      config,
      setStatus: (status) => host.ltStatus?.set(status),
      notify: (text, level) => api.ui.notify(text, level),
      // R-I8.10 / AC-I8.11: só contagens e tempos (o tipo do agendador só aceita números).
      log: (event, counts) => console.debug(`[simplemd] languagetool ${event}`, counts),
    });

    const actions: LtActions = {
      async addWord(word) {
        const words = stringList(api.settings.get<unknown>('dictionary'));
        if (words.includes(word)) return true;
        if (words.length >= MAX_DICTIONARY_WORDS) {
          api.ui.notify(
            `Ortografia e gramática: o dicionário pessoal já tem ${MAX_DICTIONARY_WORDS.toLocaleString('pt-BR')} palavras.`,
            'warn',
          );
          return false;
        }
        await api.settings.set('dictionary', [...words, word]);
        return true;
      },
      async disableRule(ruleId) {
        const rules = stringList(api.settings.get<unknown>('disabledRules'));
        if (!rules.includes(ruleId)) await api.settings.set('disabledRules', [...rules, ruleId]);
      },
      announce: (text) => host.editor.announce(text),
    };

    const checkNow: InternalCommand = {
      id: CHECK_NOW_ID,
      title: CHECK_NOW_TITLE,
      hotkey: CHECK_NOW_KEY,
      run: () => {
        checker.checkNow();
        return true;
      },
    };

    const extension: Extension = [
      ltField,
      ltLinter(actions),
      diagnosticsExtension(host),
      keymap.of([{ key: CHECK_NOW_KEY, run: checkNow.run, preventDefault: true }]),
      ViewPlugin.define((view) => {
        checker.attach(view);
        return {
          update(update) {
            checker.update(update);
            if (update.startState.field(ltField, false) !== update.state.field(ltField, false))
              repaint(update.view);
          },
          destroy: () => checker.detach(view),
        };
      }),
      host.palette?.([checkNow]) ?? [],
    ];
    api.registerEditorExtension({ source: extension });

    const offAction = host.ltStatus?.onAction((action) =>
      action === 'retry' ? checker.retry() : checker.checkNow(),
    );
    const offOptions = host.options.subscribe(() => checker.configChanged());
    const onFocus = () => checker.windowFocused();
    window.addEventListener('focus', onFocus);

    return () => {
      window.removeEventListener('focus', onFocus);
      offOptions();
      offAction?.();
      checker.destroy();
      host.ltStatus?.clear();
    };
  };
}
