import type { PluginAPI } from '@simplemd/plugin-api';
import type { InternalHostContext } from '@simplemd/plugin-api/internal/host';
import type { SpellCoverage } from '@simplemd/plugin-api/internal/spell';
import type { InternalEnabledNote, PluginOptionSpec } from '@simplemd/plugin-api/runtime';
import type { CatalogController } from '../../catalog/catalog';
import type { EditorAssembly } from '../../editor/assembly';
import type { AppPlatform } from '../../platform/types';
import type { DictionaryService } from '../../state/dictionary';
import type { DocumentRegistry } from '../../state/documents';
import type { SpellCoverageService } from '../../state/spell-coverage';
import type { AppStore } from '../../state/store';
import type { SyncController } from '../../state/sync';

/**
 * Tipos e `defineInternalPlugin` do registro dos plugins internos (r7 D-R7-F01). Ficam fora do
 * coletor (`index.ts`) e fora do glob dele: cada descritor `./<id>.ts` importa só este arquivo, então
 * não há import circular descritor ↔ coletor e um descritor pode ser importado sozinho (CR-S0-01).
 */

/** O corretor offline (r35c): o único registro que recebe o motor (`spellEngine`). */
export const SPELL_PLUGIN_ID = 'simplemd.spell';

/**
 * A língua de uma nota sem `lang:` que o LanguageTool ligado usa — o "Idioma padrão" dele, pt-BR no
 * automático —, ou `null` com ele desligado (D-R35B-01): o corretor offline a segue, então a
 * ortografia de uma nota nunca é dos dois.
 */
export interface NoteLanguageService {
  get(): string | null;
  /** Avisa quando o LanguageTool liga, desliga ou troca o "Idioma padrão". */
  subscribe(listener: () => void): () => void;
}

/**
 * Objetos do app para os arquivos de registro (DA-R7-26), nunca para o código do plugin: o registro
 * do `simplemd.tasks` monta o catálogo de tarefas a partir deles, por closure no próprio arquivo.
 * É o que o runtime entrega (`contextFor`); cada registro os vê pela `InternalRegistrationServices`.
 */
export interface InternalAppServices {
  readonly platform: AppPlatform;
  readonly store: AppStore;
  readonly registry: DocumentRegistry;
  readonly catalog: CatalogController;
  readonly sync: SyncController;
  readonly editor: EditorAssembly;
  /** Dicionário do usuário (r32b): os registros do LanguageTool e do corretor offline o entregam. */
  readonly dictionary: DictionaryService;
  /**
   * Corretor offline (r35a; D-R35-1): a cobertura de línguas e o caminho único do app para
   * `spell_reload` (`reload`; o transporte de `check`/`suggest` é `platform.spell`). Os registros só
   * a leem (`SpellCoverage`); a escrita e a recarga chegam só ao do `simplemd.spell`, como
   * `spellEngine` (AppSec r35a N3).
   */
  readonly spellCoverage: SpellCoverageService;
  /** D-R35B-01: ausente num host de teste (o corretor vale pt-BR para as notas sem `lang:`). */
  readonly noteLanguage?: NoteLanguageService;
}

/**
 * A plataforma como um arquivo de registro a vê: o transporte do corretor offline (`spell`, com
 * `check`, `suggest` e `reload`) só no registro do `simplemd.spell`; nos outros ele nem existe —
 * nenhum chama `spell_reload` por fora da porta única do app nem cancela as verificações do
 * corretor (AppSec r35c N2).
 */
export type InternalRegistrationPlatform = Omit<AppPlatform, 'spell'> & {
  readonly spell?: AppPlatform['spell'];
};

/**
 * Os serviços como um arquivo de registro os vê: a cobertura do corretor offline só para leitura
 * (AppSec r35a N3) — `set`/`clear`/`reload` nem existem no objeto entregue — e a plataforma sem o
 * transporte do corretor fora do registro dele.
 */
export interface InternalRegistrationServices extends Omit<
  InternalAppServices,
  'platform' | 'spellCoverage'
> {
  readonly platform: InternalRegistrationPlatform;
  readonly spellCoverage: SpellCoverage;
}

/** O que o runtime monta para o `load` de UM plugin (`contextFor` em `runtime.ts`). */
export interface InternalLoadContext {
  readonly pluginId: string;
  /** Vai para o código do plugin (montado por plugin em `runtime.ts`, `contextFor`). */
  readonly host: InternalHostContext;
  /** Fica no arquivo de registro (DA-R7-26). */
  readonly services: InternalAppServices;
}

/**
 * O que o `load` de um arquivo de registro recebe (menor privilégio: cada plugin o seu), montado por
 * `defineInternalPlugin` a partir do contexto do runtime.
 */
export interface InternalRegistrationContext {
  readonly pluginId: string;
  readonly host: InternalHostContext;
  readonly services: InternalRegistrationServices;
  /**
   * Só no registro do `simplemd.spell` (D-R35-1; AppSec r35a N3), o único descritor com o id
   * (AppSec r35c N3): a cobertura com escrita (`set` com as línguas da recarga, `clear`) e o caminho
   * único do app para `spell_reload` (`reload`). Para os demais, ausente.
   */
  readonly spellEngine?: SpellCoverageService;
}

/** Módulo de um plugin interno: o mesmo `activate` (um argumento) dos plugins externos. */
export interface InternalPluginModule {
  readonly default: (api: PluginAPI) => void | (() => void);
}

export interface InternalPluginDescriptor {
  readonly id: `simplemd.${string}`;
  readonly name: string;
  readonly description: string;
  /** Ligado num vault sem escolha explícita (D-R7-P01; igual a `INTERNAL_PLUGIN_DEFAULTS`). */
  readonly defaultEnabled: boolean;
  /** Ordem de ativação = ordem das extensões no editor (mermaid 10 … languagetool 90). */
  readonly order: number;
  /** Opções no gerenciador (R-X7.4, DA-R7-12), no `data.json` do `api.settings`. */
  readonly options?: readonly PluginOptionSpec[];
  /** Linha de motivo enquanto ligado (LT-ENABLE: STR-170 + "Como instalar"). */
  readonly enabledNote?: InternalEnabledNote;
  load(ctx: InternalLoadContext): Promise<InternalPluginModule>;
}

/** O descritor como o arquivo de registro o escreve: o `load` recebe o contexto do registro. */
export interface InternalPluginDefinition extends Omit<InternalPluginDescriptor, 'load'> {
  load(ctx: InternalRegistrationContext): Promise<InternalPluginModule>;
}

/** Cópia rasa da plataforma sem o transporte do corretor (AppSec r35c N2). */
function withoutSpell(platform: AppPlatform): InternalRegistrationPlatform {
  const copy: Omit<AppPlatform, 'spell'> & { spell?: AppPlatform['spell'] } = { ...platform };
  delete copy.spell;
  return copy;
}

/** O `simplemd.spell` já tem descritor: o motor vai a um registro só (AppSec r35c N3). */
let spellDefined = false;

/**
 * O descritor de `./<id>.ts` (`export default defineInternalPlugin({ … })`). O `load` dele passa a
 * receber o contexto do registro: a cobertura do corretor offline vira um objeto só de leitura, e o
 * motor (`spellEngine`) e o transporte dele (`platform.spell`) vão só ao `simplemd.spell` —
 * privilégio por id, como a tabela `PRIVILEGES` de `internal-context.ts` para o contexto do host. O
 * id do corretor é de um descritor só: um segundo é erro de programação e falha aqui, na carga do
 * módulo, e o `load` só concede com o contexto do mesmo id (AppSec r35c N3).
 */
export function defineInternalPlugin(
  definition: InternalPluginDefinition,
): InternalPluginDescriptor {
  const { load, ...descriptor } = definition;
  const privileged = definition.id === SPELL_PLUGIN_ID;
  if (privileged) {
    if (spellDefined)
      throw new Error(
        `plugins/internal: um segundo descritor com o id ${SPELL_PLUGIN_ID}; o motor do corretor vai a um registro só.`,
      );
    spellDefined = true;
  }
  return {
    ...descriptor,
    load: ({ pluginId, host, services }) => {
      const own = privileged && pluginId === SPELL_PLUGIN_ID;
      const engine = services.spellCoverage;
      return load({
        pluginId,
        host,
        services: {
          ...services,
          platform: own ? services.platform : withoutSpell(services.platform),
          spellCoverage: {
            languageFor: (fmLang) => engine.languageFor(fmLang),
            subscribe: (listener) => engine.subscribe(listener),
          },
        },
        ...(own ? { spellEngine: engine } : {}),
      });
    },
  };
}
