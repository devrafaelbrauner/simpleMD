// Portado de artisticat1/obsidian-latex-suite@5db51cf36abccdbbfa51184bb5fe86be8157cc2f (MIT), © 2022 artisticat1. Modificado para o simpleMD.
// Origem: src/snippets/options.ts. Mudanças: sem os modos `code`/`codeMath` (Q-R7-F09 e R-I6.1:
// nada expande em código; blocos ```math não são matemática no simpleMD); o modo "pega-tudo" de
// uma entrada sem letra de modo vale para texto e matemática, nunca para código.

/** Letras de opção aceitas (R-I6.2); `c` (código) fica fora (Q-R7-F09). */
export const OPTION_LETTERS = 'ArmtMnvw';

export class Mode {
  text = false;
  inlineMath = false;
  blockMath = false;
  /** Dentro de `\text{…}`, `\tag{…}`, `\begin{…}`/`\end{…}` numa fórmula. */
  textEnv = false;

  /** Dentro de `$…$` ou de um bloco `$$`. */
  inMath(): boolean {
    return this.inlineMath || this.blockMath;
  }

  /** Matemática, fora de um ambiente de texto como `\text{}`. */
  strictlyInMath(): boolean {
    return this.inMath() && !this.textEnv;
  }

  static fromSource(source: string): Mode {
    const mode = new Mode();
    for (const flag of source) {
      if (flag === 'm') {
        mode.blockMath = true;
        mode.inlineMath = true;
      } else if (flag === 'n') mode.inlineMath = true;
      else if (flag === 'M') mode.blockMath = true;
      else if (flag === 't') mode.text = true;
    }
    if (!(mode.text || mode.inlineMath || mode.blockMath)) {
      // Compatibilidade do upstream: sem letra de modo = vale em toda parte (aqui: texto e matemática).
      mode.text = true;
      mode.inlineMath = true;
      mode.blockMath = true;
    }
    return mode;
  }
}

export class Options {
  mode = new Mode();
  automatic = false;
  regex = false;
  onWordBoundary = false;
  visual = false;

  static fromSource(source: string): Options {
    const options = new Options();
    options.mode = Mode.fromSource(source);
    for (const flag of source) {
      if (flag === 'A') options.automatic = true;
      else if (flag === 'r') options.regex = true;
      else if (flag === 'w') options.onWordBoundary = true;
      else if (flag === 'v') options.visual = true;
    }
    return options;
  }
}
