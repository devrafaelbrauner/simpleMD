import type { Extension } from '@codemirror/state';
import { keymap, ViewPlugin } from '@codemirror/view';
import type { PluginAPI } from '@simplemd/plugin-api';
import type {
  DictionaryLayer,
  InternalCommand,
  InternalHostContext,
} from '@simplemd/plugin-api/internal/host';
import { diagnosticsExtension } from '../shared/diagnostics-ui';
import { LtChecker, type LtClock, type LtConfig } from './checker';
import { ltField } from './field';
import { DEFAULT_LANGUAGE } from './language';
import { DICTIONARY_NAMES, ltLinter, repaint, type LtActions } from './present';
import { RULE_ID } from './response';

/**
 * Plugin interno "Ortografia e gramática (LanguageTool)" (r7 I-8; arch-frontend §10.5), desligado
 * por padrão. Fala só com o transporte nativo do host (`host.languageTool`: `lt_languages`,
 * `lt_check`, `lt_cancel`; variante N — nada de `fetch` no webview). Diagnósticos pela UI
 * compartilhada de S5; estado na barra de status (`host.ltStatus`) com o menu M2; comando
 * "Verificar ortografia e gramática agora" (`Mod-Shift-O`) pela paleta (`host.palette`).
 *
 * Dicionário (r32b): o do app (`host.dictionary`, camadas deste computador e desta pasta). O plugin
 * filtra a ortografia pelo `known`, grava pelo cartão na camada da opção "Adicionar palavras ao",
 * mostra os avisos de teto (D-R32-7) e, ao iniciar, passa o `dictionary` antigo do `data.json` para
 * o `pessoal.txt` da pasta (D-R32-5).
 */

export const CHECK_NOW_ID = 'simplemd.languagetool:check-now';
export const CHECK_NOW_TITLE = 'Verificar ortografia e gramática agora';
export const CHECK_NOW_KEY = 'Mod-Shift-o';

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
    const dictionary = host.dictionary;
    if (!dictionary) throw new Error('simplemd.languagetool: dicionário do app ausente');
    let disposed = false;
    const config = (): LtConfig => ({
      mode: host.options.get<string>('mode') === 'manual' ? 'manual' : 'auto',
      language: host.options.get<string | undefined>('language') ?? DEFAULT_LANGUAGE,
      disabledRules: stringList(host.options.get<unknown>('disabledRules')).filter((id) =>
        RULE_ID.test(id),
      ),
    });
    // R-I8.10 / AC-I8.11: só contagens e tempos (o tipo do agendador só aceita números).
    // Formato constante (semgrep unsafe-formatstring): o evento vai como argumento.
    const log = (event: string, counts: Readonly<Record<string, number>>) =>
      console.debug('[simplemd] languagetool', event, counts);
    const checker = new LtChecker({
      transport,
      clock,
      config,
      known: (word) => dictionary.known(word),
      setStatus: (status) => host.ltStatus?.set(status),
      notify: (text, level) => api.ui.notify(text, level),
      log,
    });

    // O host já prefixa "Ortografia e gramática (LanguageTool): " nos avisos do plugin.
    const saveFailed = (what: string, error: unknown) =>
      api.ui.notify(
        `não foi possível gravar ${what} — ${error instanceof Error ? error.message : String(error)}`,
        'error',
      );
    const actions: LtActions = {
      async addWord(word) {
        const layer: DictionaryLayer =
          host.options.get<string>('addTo') === 'folder' ? 'folder' : 'global';
        const result = await dictionary.add(word, layer);
        if (result.status === 'added' || result.status === 'exists') return layer;
        if (disposed) return null;
        const where = `o dicionário ${DICTIONARY_NAMES[layer]}`;
        if (result.status === 'full')
          api.ui.notify(
            `${where} chegou ao limite (200.000 palavras ou 10 MiB no pessoal.txt).`,
            'warn',
          );
        else if (result.status === 'invalid')
          api.ui.notify(
            `“${word}” não cabe no dicionário: até 64 caracteres, sem espaços.`,
            'warn',
          );
        else
          saveFailed(where, result.status === 'failed' ? result.message : 'nenhuma pasta aberta');
        return null;
      },
      known: (word) => dictionary.known(word),
      async disableRule(ruleId) {
        const rules = stringList(api.settings.get<unknown>('disabledRules'));
        if (rules.includes(ruleId)) return true;
        try {
          await api.settings.set('disabledRules', [...rules, ruleId]);
          return true;
        } catch (error) {
          saveFailed('a regra desativada', error);
          return false;
        }
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
      // r39a: um checker para os grupos do editor, no view com foco. Ao nascer, um view só o toma
      // se nenhum está anexado ou se tem o foco; ao ganhar o foco, o checker passa a ele e verifica
      // o que ele mostra. Com um view só, igual a antes.
      ViewPlugin.define((view) => {
        if (checker.view === null || view.hasFocus) checker.attach(view);
        return {
          update(update) {
            if (update.focusChanged && view.hasFocus && checker.view !== view) checker.attach(view);
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

    // D-R32-7: os avisos de teto das camadas, cada um uma vez enquanto a causa durar.
    const showWarnings = () => {
      for (const warning of dictionary.takeWarnings()) api.ui.notify(warning.text, 'warn');
    };
    const offDictionary = dictionary.subscribe(() => {
      checker.dictionaryChanged();
      showWarnings();
    });
    showWarnings();

    /**
     * D-R32-5: o `dictionary` do `data.json` (até a r32a, por pasta) vai uma vez para o
     * `.simplemd/dictionaries/pessoal.txt` desta pasta; a chave só sai depois de gravado (falha →
     * fica, e a próxima ativação tenta de novo). Palavras fora do formato v1 ficam na chave.
     */
    const migrate = async () => {
      const legacy = api.settings.get<unknown>('dictionary');
      if (!Array.isArray(legacy)) return;
      const result = await dictionary.addAll(stringList(legacy), 'folder');
      if (disposed) return;
      log('migrate', { words: legacy.length, rejected: result.rejected.length });
      if (result.status === 'full') {
        api.ui.notify(
          'o dicionário desta pasta chegou ao limite; as palavras do dicionário antigo continuam no data.json.',
          'warn',
        );
        return;
      }
      if (result.status !== 'added' && result.status !== 'exists') {
        saveFailed(
          'o dicionário antigo em .simplemd/dictionaries/pessoal.txt',
          result.status === 'failed' ? result.message : 'nenhuma pasta aberta',
        );
        return;
      }
      // Só sobraram palavras fora do formato: o `data.json` ficaria igual.
      if (legacy.length > 0 && result.rejected.length === legacy.length) return;
      try {
        await api.settings.set(
          'dictionary',
          result.rejected.length > 0 ? result.rejected : undefined,
        );
      } catch (error) {
        if (!disposed)
          saveFailed('o data.json (o dicionário antigo já está em pessoal.txt desta pasta)', error);
      }
    };
    void migrate();

    return () => {
      disposed = true;
      offDictionary();
      window.removeEventListener('focus', onFocus);
      offOptions();
      offAction?.();
      checker.destroy();
      host.ltStatus?.clear();
    };
  };
}
