import type { Message } from './types';

/** Comandos sobre a seleção (R-11.8; ids da paleta `ai:<id>`). */
export type AiCommand = 'rewrite' | 'summarize' | 'continue' | 'translate';

export const AI_COMMANDS: readonly AiCommand[] = ['rewrite', 'summarize', 'continue', 'translate'];

/** Rótulos da paleta (STR-132, vinculantes). */
export const AI_COMMAND_LABELS: Readonly<Record<AiCommand, string>> = {
  rewrite: 'IA: Reescrever seleção',
  summarize: 'IA: Resumir seleção',
  continue: 'IA: Continuar texto',
  translate: 'IA: Traduzir seleção',
};

/**
 * Modelos fixos em pt-BR (R-11.8; documentados no README). `{idioma}` recebe o nome pt-BR do
 * idioma de "Traduzir" (arch-ux r2 §2.5).
 */
export const AI_PROMPTS: Readonly<Record<AiCommand, string>> = {
  rewrite:
    'Reescreva o texto a seguir com clareza, mantendo o sentido, o idioma e a formatação markdown. Responda só com o texto reescrito.',
  summarize: 'Resuma o texto a seguir em poucas frases, no mesmo idioma. Responda só com o resumo.',
  continue:
    'Continue o texto a seguir no mesmo estilo e idioma, por um ou dois parágrafos. Responda só com a continuação.',
  translate:
    'Traduza o texto a seguir para {idioma}, preservando a formatação markdown. Responda só com a tradução.',
};

/** Idioma de "Traduzir" (Q-13: padrão English). */
export type AiLanguage = 'pt-BR' | 'en' | 'es' | 'fr' | 'de';

export const DEFAULT_AI_LANGUAGE: AiLanguage = 'en';

/** Opções do select (endônimos com `lang`, WCAG 3.1.2) e o nome usado no modelo do prompt. */
export const AI_LANGUAGES: ReadonlyArray<{
  readonly id: AiLanguage;
  readonly label: string;
  readonly promptName: string;
}> = [
  { id: 'pt-BR', label: 'Português (Brasil)', promptName: 'português do Brasil' },
  { id: 'en', label: 'English', promptName: 'inglês' },
  { id: 'es', label: 'Español', promptName: 'espanhol' },
  { id: 'fr', label: 'Français', promptName: 'francês' },
  { id: 'de', label: 'Deutsch', promptName: 'alemão' },
];

export const isAiLanguage = (value: unknown): value is AiLanguage =>
  AI_LANGUAGES.some((language) => language.id === value);

/** Mensagens de um comando: o modelo fixo como `system` e a seleção, sem mudança, como `user`. */
export function commandMessages(
  command: AiCommand,
  selection: string,
  language: AiLanguage,
): Message[] {
  const name = AI_LANGUAGES.find((l) => l.id === language)?.promptName ?? 'inglês';
  return [
    { role: 'system', content: AI_PROMPTS[command].replace('{idioma}', name) },
    { role: 'user', content: selection },
  ];
}
