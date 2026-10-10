// Portado de artisticat1/obsidian-latex-suite@5db51cf36abccdbbfa51184bb5fe86be8157cc2f (MIT), © 2022 artisticat1. Modificado para o simpleMD.
// Origem: src/snippets/snippets.ts. Mudanças: só dados (R-I6.7: nenhuma substituição-função; uma
// substituição é sempre texto); o gatilho é testado contra uma JANELA do documento (os 100
// caracteres antes do cursor, R-I6.7) em vez do documento inteiro até o cursor, e `process`
// devolve a posição de início em coordenadas do documento.
import type { Environment } from './environment';
import type { Options } from './options';

/** Em snippets visuais, o marcador substituído pela seleção. */
export const VISUAL_SNIPPET_MAGIC_SELECTION_PLACEHOLDER = '${VISUAL}';

export type SnippetType = 'visual' | 'regex' | 'string';

/** Texto testado: `text` começa na posição `offset` do documento (e pode terminar com a tecla). */
export interface SnippetWindow {
  readonly text: string;
  readonly offset: number;
}

export interface ProcessSnippetResult {
  /** Início do trecho substituído, em coordenadas do documento. */
  readonly triggerPos: number;
  readonly replacement: string;
}

interface SnippetInit<T> {
  readonly trigger: T;
  readonly replacement: string;
  readonly options: Options;
  readonly priority?: number | undefined;
  readonly description?: string | undefined;
  readonly excludedEnvironments?: readonly Environment[];
}

/** Tudo o que é preciso para rodar um snippet; os dados do tipo ficam no gatilho. */
export abstract class Snippet<T extends string | RegExp = string | RegExp> {
  abstract readonly type: SnippetType;
  readonly trigger: T;
  readonly replacement: string;
  readonly options: Options;
  readonly priority: number | undefined;
  readonly description: string | undefined;
  readonly excludedEnvironments: readonly Environment[];

  constructor(init: SnippetInit<T>) {
    this.trigger = init.trigger;
    this.replacement = init.replacement;
    this.options = init.options;
    this.priority = init.priority;
    this.description = init.description;
    this.excludedEnvironments = init.excludedEnvironments ?? [];
  }

  /** `sel` = texto selecionado (vazio sem seleção); `selFrom` = início da seleção no documento. */
  abstract process(window: SnippetWindow, selFrom: number, sel: string): ProcessSnippetResult | null;
}

/** Só com seleção: envolve a seleção (`${VISUAL}`). */
export class VisualSnippet extends Snippet<string> {
  readonly type = 'visual';

  process(window: SnippetWindow, selFrom: number, sel: string): ProcessSnippetResult | null {
    if (!sel || !window.text.endsWith(this.trigger)) return null;
    return {
      triggerPos: selFrom,
      replacement: this.replacement.replace(VISUAL_SNIPPET_MAGIC_SELECTION_PLACEHOLDER, sel),
    };
  }
}

/** Gatilho por expressão regular (ancorada no fim, `$`), grupos em `[[0]]`, `[[1]]`… */
export class RegexSnippet extends Snippet<RegExp> {
  readonly type = 'regex';

  process(window: SnippetWindow, _selFrom: number, sel: string): ProcessSnippetResult | null {
    if (sel) return null;
    const result = this.trigger.exec(window.text);
    if (result === null) return null;
    let replacement = this.replacement;
    for (let i = 1; i < result.length; i++)
      replacement = replacement.replaceAll(`[[${i - 1}]]`, result[i] ?? '');
    return { triggerPos: window.offset + result.index, replacement };
  }
}

/** Gatilho literal no fim do texto. */
export class StringSnippet extends Snippet<string> {
  readonly type = 'string';

  process(window: SnippetWindow, _selFrom: number, sel: string): ProcessSnippetResult | null {
    if (sel || !window.text.endsWith(this.trigger)) return null;
    return {
      triggerPos: window.offset + window.text.length - this.trigger.length,
      replacement: this.replacement,
    };
  }
}
