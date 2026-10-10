import type { Extension } from '@codemirror/state';
import type { PluginAPI } from '@simplemd/plugin-api';
import type { InternalHostContext } from '@simplemd/plugin-api/internal/host';
import { defaultSnippets, SnippetCatalog } from './catalog';
import { latexSuiteConfig, type LatexSuiteSettings } from './cm/config';
import { snippetInvertedEffects } from './cm/history';
import { tabstopsField, tabstopTheme } from './cm/tabstops';
import { latexKeys } from './keys';
import {
  ignoredNotice,
  problemNotice,
  USER_SNIPPETS_FILE,
  userSnippetsFrom,
  userSnippetsInfo,
} from './user-snippets';

export { USER_SNIPPETS_FILE } from './user-snippets';

/** Chaves das opções do plugin (R-I6.6; padrão ligado), lidas a cada tecla. */
export const LATEX_OPTION_KEYS = {
  autofraction: 'autofraction',
  matrixShortcuts: 'matrixShortcuts',
  tabout: 'tabout',
  autoEnlargeBrackets: 'autoEnlargeBrackets',
} as const;

/** Extensões do editor com a configuração dada (o plugin e os testes montam a mesma pilha). */
export function latexSnippetsExtension(
  settings: LatexSuiteSettings,
  host: InternalHostContext,
): Extension {
  return [
    latexSuiteConfig.of(settings),
    tabstopsField,
    snippetInvertedEffects,
    tabstopTheme,
    latexKeys(host),
  ];
}

/**
 * Plugin interno "Snippets LaTeX" (r7 I-6; porte do `obsidian-latex-suite` 1.9.8, MIT, sem o
 * pacote `obsidian`): desligado por padrão; só muda a digitação dentro de `$…$`/`$$…$$` (e dos
 * snippets de texto `t`), nunca em código, front matter ou HTML. Recebe o contexto privado do host
 * pelo arquivo de registro (`apps/desktop/src/plugins/internal/latex-snippets.ts`).
 */
export function activate(api: PluginAPI, host: InternalHostContext): () => void {
  let catalog = new SnippetCatalog(defaultSnippets());
  const option = (key: string) => () => host.options.get<boolean>(key) !== false;
  const settings: LatexSuiteSettings = {
    catalog: () => catalog,
    autofraction: option(LATEX_OPTION_KEYS.autofraction),
    matrixShortcuts: option(LATEX_OPTION_KEYS.matrixShortcuts),
    tabout: option(LATEX_OPTION_KEYS.tabout),
    autoEnlargeBrackets: option(LATEX_OPTION_KEYS.autoEnlargeBrackets),
    announce: (text) => host.editor.announce(text),
    platform: host.platform,
    hint: { shown: false },
  };
  api.registerEditorExtension({ source: latexSnippetsExtension(settings, host) });

  let disposed = false;
  /** Lê `.simplemd/latex-snippets.json` (lista fechada, ≤ 256 KiB) e refaz o catálogo. */
  const load = async () => {
    const read = host.files ? await host.files.read(USER_SNIPPETS_FILE) : null;
    if (disposed) return;
    const user = userSnippetsFrom(read);
    catalog = new SnippetCatalog([...defaultSnippets(), ...user.snippets]);
    if (user.problem) api.ui.notify(problemNotice(user.problem), 'warn');
    else if (user.ignored > 0) api.ui.notify(ignoredNotice(user.ignored), 'warn');
  };
  void load();
  const unwatch = host.files?.onChange((name) => {
    if (name === USER_SNIPPETS_FILE) void load();
  });
  return () => {
    disposed = true;
    unwatch?.();
  };
}

/**
 * Texto `info` "Snippets desta pasta" das opções (calculado pelo app pelo leitor da lista fechada,
 * mesmo com o plugin desligado).
 */
export function describeUserSnippets(
  read: { readonly text: string } | { readonly error: string } | null,
): string {
  if (read !== null && 'error' in read) {
    const known = read.error === 'missing' || read.error === 'too-large';
    return userSnippetsInfo(userSnippetsFrom({ error: known ? read.error : 'read' }));
  }
  return userSnippetsInfo(userSnippetsFrom(read));
}

export default activate;
