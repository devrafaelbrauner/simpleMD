import { LANGUAGETOOL_DOCS_URL } from '../../app/status-bar';
import { defineInternalPlugin } from './define';

/** STR-170: explicação ao ligar (R-I8.1). */
export const LANGUAGETOOL_ENABLED_NOTE =
  'Precisa de um servidor LanguageTool rodando neste computador em http://localhost:8081. O texto vai só para esse servidor local.';

/**
 * "Como instalar" da linha do plugin: o descritor é estático; o `openExternal` do contexto deste
 * plugin chega no `load` (a linha de motivo só aparece com o plugin ligado, depois do `load`).
 */
let openInstallDocs: () => void = () => undefined;

/** Ortografia e gramática com um LanguageTool local (r7 I-8), desligado por padrão (D-R7-P01). */
export default defineInternalPlugin({
  id: 'simplemd.languagetool',
  name: 'Ortografia e gramática (LanguageTool)',
  description:
    'Revisão de ortografia e gramática por um servidor LanguageTool instalado neste computador. O texto não sai do computador.',
  defaultEnabled: false,
  order: 90,
  options: [
    {
      key: 'mode',
      kind: 'select',
      label: 'Verificação',
      default: 'auto',
      choices: [
        { value: 'auto', label: 'Automática (ao parar de digitar)' },
        { value: 'manual', label: 'Manual (pelo comando)' },
      ],
    },
    {
      key: 'language',
      kind: 'select',
      label: 'Idioma padrão',
      default: 'pt-BR',
      choices: [
        { value: 'pt-BR', label: 'Português (Brasil)', lang: 'pt-BR' },
        { value: 'pt-PT', label: 'Português (Portugal)', lang: 'pt-PT' },
        { value: 'en-US', label: 'English (US)', lang: 'en-US' },
        { value: 'en-GB', label: 'English (UK)', lang: 'en-GB' },
        { value: 'es', label: 'Español', lang: 'es' },
        { value: 'fr', label: 'Français', lang: 'fr' },
        { value: 'de', label: 'Deutsch', lang: 'de' },
        { value: 'auto', label: 'Automático' },
      ],
    },
    {
      key: 'dictionary',
      kind: 'info',
      label: 'Dicionário pessoal',
      info: ({ values }) => {
        const words = Array.isArray(values.dictionary) ? values.dictionary.length : 0;
        return words === 1 ? '1 palavra' : `${words} palavras`;
      },
    },
    {
      key: 'disabledRules',
      kind: 'list',
      label: 'Regras desativadas',
      default: [],
      maxItems: 1000,
      removeLabel: (id) => `Reativar ${id}`,
      emptyText: 'Nenhuma regra desativada.',
    },
  ],
  enabledNote: {
    text: LANGUAGETOOL_ENABLED_NOTE,
    action: { label: 'Como instalar', run: () => openInstallDocs() },
  },
  load: async ({ host }) => {
    openInstallDocs = () => host.links.openExternal(LANGUAGETOOL_DOCS_URL);
    // Pedaço sob demanda (NFR-54, AC-X7.4): 0 bytes do plugin com ele desligado na partida.
    const { createLanguageToolPlugin } = await import('@simplemd/plugins-internal/languagetool');
    return { default: createLanguageToolPlugin(host) };
  },
});
