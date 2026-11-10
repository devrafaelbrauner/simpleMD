import type { EditorState, Extension } from '@codemirror/state';
import { ViewPlugin, type EditorView } from '@codemirror/view';
import type { PluginAPI } from '@simplemd/plugin-api';
import type {
  DictionaryHost,
  DictionaryLayer,
  InternalHostContext,
} from '@simplemd/plugin-api/internal/host';
import type { SpellCoverage } from '@simplemd/plugin-api/internal/spell';
import { diagnosticsExtension } from '../shared/diagnostics-ui';
import { frontMatterLang } from '../shared/prose';
import { SpellChecker, type SpellClock, type SpellEngine } from './checker';
import {
  DICTIONARY_NAMES,
  repaint,
  spellClearAll,
  spellField,
  spellLinter,
  spellRemoveWhere,
  type SpellActions,
  type SpellDiag,
} from './present';

export { SPELL_LIMITS, SPELL_TIMING, type SpellClock, type SpellEngine } from './checker';

/**
 * Plugin interno "Ortografia offline" (`simplemd.spell`, r35c; design-r35 §1), ligado por padrão:
 * sublinha as palavras que o motor offline da r34 (o pt-BR do VERO embutido mais as camadas do
 * dicionário do usuário, no Rust) não conhece, sem rede e sem servidor. Diagnósticos e cartão pela
 * UI compartilhada do lint e do LanguageTool (`shared/diagnostics-ui.ts`).
 *
 * O plugin só verifica e sugere (`SpellEngine`: `check`/`suggest`; code-review r35a N3): recarregar
 * o motor e escrever a cobertura de línguas são do arquivo de registro do app. Dele chegam também a
 * cobertura só para leitura (a língua de cada nota), o dicionário do usuário (filtro no cliente,
 * "Adicionar ao dicionário"), as palavras ignoradas na sessão e o aviso de que o motor recarregou.
 *
 * Língua da nota: a do `lang:` do front matter; sem ele, a que o LanguageTool ligado usaria (o
 * "Idioma padrão" dele, pt-BR no automático; D-R35B-01) ou pt-BR (D-R35-3) — então a ortografia de
 * uma nota é sempre de um só dos dois. Fora da cobertura (`lang: en-US`), nada é verificado.
 */

/**
 * A língua de uma nota sem `lang:` que o LanguageTool ligado usa (D-R35B-01); `null` com ele
 * desligado. Montada pelo app.
 */
export interface NoteLanguage {
  get(): string | null;
  subscribe(listener: () => void): () => void;
}

export interface SpellPluginDeps {
  readonly engine: SpellEngine;
  /** Só leitura (AppSec r35a N3): a língua do motor que cobre o `lang:` da nota. */
  readonly coverage: SpellCoverage;
  readonly dictionary: DictionaryHost;
  /** Ausente: o LanguageTool não decide a língua das notas sem `lang:` (vale pt-BR). */
  readonly noteLanguage?: NoteLanguage;
  /** "Ignorar" (D-R35-2): as palavras escondidas nesta sessão do app; nunca gravadas. */
  readonly ignored: Set<string>;
  /** Avisa quando o motor recarregou (o dicionário do usuário mudou): as respostas guardadas caem. */
  onReload(listener: () => void): () => void;
}

const systemClock: SpellClock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as number),
};

/**
 * `activate` do plugin para o contexto do host (o registro chama com o `host` deste plugin e as
 * dependências do app). `clock` só muda nos testes (relógio falso).
 */
export function createSpellPlugin(
  host: InternalHostContext,
  deps: SpellPluginDeps,
  clock: SpellClock = systemClock,
): (api: PluginAPI) => () => void {
  return (api) => {
    const { dictionary, ignored } = deps;
    let disposed = false;
    // Formato constante (semgrep unsafe-formatstring): o evento vai como argumento; só contagens.
    const log = (event: string, counts: Readonly<Record<string, number>>) =>
      console.debug('[simplemd] spell', event, counts);
    const language = (state: EditorState): string | null =>
      deps.coverage.languageFor(frontMatterLang(state) ?? deps.noteLanguage?.get() ?? null);
    const checker = new SpellChecker({
      engine: deps.engine,
      clock,
      language,
      known: (word) => dictionary.known(word),
      ignored: (word) => ignored.has(word),
      log,
    });

    /** Os views vivos (r39: um por grupo do editor); o checker fica no do grupo com foco. */
    const live = new Set<EditorView>();
    /** Tira de todos os views os sublinhados que `drop` aponta. */
    const dropEverywhere = (drop: (diag: SpellDiag) => boolean) => {
      for (const view of live)
        if (view.state.field(spellField, false)?.some(drop))
          view.dispatch({ effects: spellRemoveWhere.of(drop) });
    };
    const removeKnown = () => dropEverywhere((d) => dictionary.known(d.word));

    // O host já prefixa "Ortografia offline: " nos avisos do plugin.
    const actions: SpellActions = {
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
          api.ui.notify(
            `não foi possível gravar ${where} — ${result.status === 'failed' ? result.message : 'nenhuma pasta aberta'}`,
            'error',
          );
        return null;
      },
      ignore(word) {
        ignored.add(word);
        dropEverywhere((d) => d.word === word);
      },
      dictionaryChanged: removeKnown,
      announce: (text) => host.editor.announce(text),
    };

    /** A língua de uma nota mudou de lado: fora da cobertura, os sublinhados dela saem. */
    const languageChanged = () => {
      for (const view of live)
        if (language(view.state) === null && view.state.field(spellField, false)?.length)
          view.dispatch({ effects: spellClearAll.of(null) });
      checker.languageChanged();
    };

    // r39: um checker para os grupos do editor, no view com foco (como o LanguageTool): ao nascer,
    // a cada troca de grupo do app (`focusedView`) e ao ganhar o foco do DOM.
    const { focusedView } = host.editor;
    const offFocusedView = focusedView?.subscribe(() => {
      const view = focusedView.get();
      if (view && live.has(view) && checker.view !== view) checker.attach(view);
    });
    const extension: Extension = [
      spellField,
      spellLinter(actions),
      diagnosticsExtension(host),
      ViewPlugin.define((view) => {
        live.add(view);
        if (checker.view === null || view.hasFocus || view === focusedView?.get())
          checker.attach(view);
        return {
          update(update) {
            if (update.focusChanged && view.hasFocus && checker.view !== view) checker.attach(view);
            checker.update(update);
            if (
              update.startState.field(spellField, false) !== update.state.field(spellField, false)
            )
              repaint(update.view);
          },
          destroy: () => {
            live.delete(view);
            checker.detach(view);
          },
        };
      }),
    ];
    api.registerEditorExtension({ source: extension });

    const offCoverage = deps.coverage.subscribe(languageChanged);
    const offNoteLanguage = deps.noteLanguage?.subscribe(languageChanged);
    const offDictionary = dictionary.subscribe(removeKnown);
    const offReload = deps.onReload(() => checker.engineReloaded());

    return () => {
      disposed = true;
      offReload();
      offDictionary();
      offNoteLanguage?.();
      offCoverage();
      offFocusedView?.();
      checker.destroy();
    };
  };
}
