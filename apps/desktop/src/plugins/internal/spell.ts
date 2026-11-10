import type { SpellErrorCode } from '@simplemd/plugin-api/internal/spell';
import type { DictionaryService } from '../../state/dictionary';
import type { SpellCoverageService } from '../../state/spell-coverage';
import { defineInternalPlugin, SPELL_PLUGIN_ID } from './define';

/** Espera depois da última mudança do dicionário do usuário antes de recarregar o motor. */
export const SPELL_DICTIONARY_RELOAD_MS = 250;

/** O aviso de uma recarga que falhou (uma vez por ativação; o host prefixa "Ortografia offline: "). */
export const SPELL_RELOAD_FAILED =
  'o dicionário não carregou; nada é sublinhado até a próxima recarga (ao abrir a pasta ou mudar o dicionário).';

/**
 * Falhas que vêm de fora e não dizem nada do motor (AppSec r35b N4, laço da AppSec r35a N1): um
 * plugin aprovado recarregou por cima (`CANCELLED`, já repetido pelo serviço) ou a pasta trocou no
 * meio. A cobertura fica como estava — limpar faria o LanguageTool apagar e pedir de novo a cada
 * troca provocada por fora.
 */
const FROM_OUTSIDE: Readonly<Partial<Record<SpellErrorCode, true>>> = {
  CANCELLED: true,
  VAULT_CLOSED: true,
  NO_VAULT: true,
};

/**
 * "Ignorar" (D-R35-2): as palavras escondidas nesta sessão do app, por janela (o serviço do motor é
 * um por `AppController`), de uma ativação à outra e de uma pasta à outra; nunca gravadas (LGPD).
 */
const ignoredBySession = new WeakMap<SpellCoverageService, Set<string>>();

/**
 * O motor enquanto o plugin está ligado (design-r35 §1; contrato da r35a): recarrega ao ligar e a
 * cada mudança do dicionário do usuário depois da primeira carga dele (250 ms de espera), sempre por
 * `spellEngine.reload('folder')` — nunca `platform.spell.reload` (a porta única do app). Recarga
 * feita → as línguas viram a cobertura e o plugin esquece as respostas guardadas; falha do motor →
 * sem cobertura e um aviso; falha de fora → nada muda. Desligar tira a cobertura (o LanguageTool
 * volta a cuidar da ortografia).
 */
function runEngine(
  engine: SpellCoverageService,
  dictionary: DictionaryService,
  reloaded: () => void,
  warn: () => void,
): () => void {
  let stopped = false;
  let armed = false;
  let warned = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const reload = () => {
    engine.reload('folder').then(
      ({ langs }) => {
        if (stopped) return;
        engine.set(langs);
        reloaded();
      },
      (error: unknown) => {
        const code = (error as { readonly code?: SpellErrorCode } | null)?.code;
        if (stopped || (code !== undefined && FROM_OUTSIDE[code])) return;
        engine.clear();
        if (warned) return;
        warned = true;
        warn();
      },
    );
  };
  reload();
  // A primeira carga do dicionário é a do disco que o motor acabou de ler: só o que muda depois dela.
  const offDictionary = dictionary.subscribe(() => {
    if (!armed || stopped) return;
    clearTimeout(timer);
    timer = setTimeout(reload, SPELL_DICTIONARY_RELOAD_MS);
  });
  void dictionary.ready().then(() => {
    armed = true;
  });
  return () => {
    stopped = true;
    offDictionary();
    clearTimeout(timer);
    engine.clear();
  };
}

/**
 * Corretor ortográfico offline (r35c; design-r35 §1), ligado por padrão: o motor pt-BR da r34 no
 * Rust, sem rede. O código do plugin recebe só `check`/`suggest` (code-review r35a N3); a recarga do
 * motor e a escrita da cobertura de línguas ficam aqui (`runEngine`).
 */
export default defineInternalPlugin({
  id: SPELL_PLUGIN_ID,
  name: 'Ortografia offline',
  description:
    'Sublinha as palavras fora do dicionário de português do Brasil embutido e do seu dicionário. Funciona sem internet e sem servidor: o texto não sai do computador.',
  defaultEnabled: true,
  order: 85,
  options: [
    {
      // D-R35-5: a camada que "Adicionar ao dicionário" grava, como no LanguageTool.
      key: 'addTo',
      kind: 'select',
      label: 'Adicionar palavras ao',
      help: 'Onde “Adicionar ao dicionário” grava a palavra. Este computador: vale em todas as pastas abertas aqui. Esta pasta: fica em .simplemd/dictionaries/pessoal.txt e viaja com a pasta.',
      default: 'global',
      choices: [
        { value: 'global', label: 'Este computador' },
        { value: 'folder', label: 'Esta pasta' },
      ],
    },
    {
      // D-R35-5 / r32c: a lista das duas camadas do dicionário do app (a mesma do LanguageTool).
      key: 'userDictionary',
      kind: 'dictionary',
      label: 'Dicionário',
      help: 'Palavras que não são sublinhadas como erro de ortografia. Remover tira a palavra dos arquivos .txt lidos da camada (um arquivo deixado de fora pelos limites continua com ela); o sublinhado volta na próxima verificação.',
    },
  ],
  load: async ({ host, services, spellEngine }) => {
    if (!spellEngine) throw new Error('simplemd.spell: o motor do app não chegou ao registro');
    // Pedaço sob demanda (NFR-54): 0 bytes do plugin com ele desligado na partida.
    const { createSpellPlugin } = await import('@simplemd/plugins-internal/spell');
    const { spell } = services.platform;
    let ignored = ignoredBySession.get(spellEngine);
    if (!ignored) {
      ignored = new Set();
      ignoredBySession.set(spellEngine, ignored);
    }
    const reloads = new Set<() => void>();
    const activate = createSpellPlugin(host, {
      // code-review r35a N3: só verificar e sugerir; recarregar é deste arquivo, pelo serviço.
      engine: {
        check: (lang, words) => spell.check(lang, words),
        suggest: (lang, word) => spell.suggest(lang, word),
      },
      coverage: {
        languageFor: (fmLang) => spellEngine.languageFor(fmLang),
        subscribe: (listener) => spellEngine.subscribe(listener),
      },
      dictionary: services.dictionary,
      ...(services.noteLanguage ? { noteLanguage: services.noteLanguage } : {}),
      ignored,
      onReload: (listener) => {
        reloads.add(listener);
        return () => reloads.delete(listener);
      },
    });
    return {
      default: (api) => {
        const stopPlugin = activate(api);
        const stopEngine = runEngine(
          spellEngine,
          services.dictionary,
          () => {
            for (const listener of [...reloads]) listener();
          },
          () => api.ui.notify(SPELL_RELOAD_FAILED, 'warn'),
        );
        return () => {
          stopPlugin();
          stopEngine();
        };
      },
    };
  },
});
