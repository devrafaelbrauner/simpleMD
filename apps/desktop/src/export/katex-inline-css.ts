import katexCss from 'katex/dist/katex.min.css?raw';
import AMSRegular from 'katex/dist/fonts/KaTeX_AMS-Regular.woff2?inline';
import CaligraphicBold from 'katex/dist/fonts/KaTeX_Caligraphic-Bold.woff2?inline';
import CaligraphicRegular from 'katex/dist/fonts/KaTeX_Caligraphic-Regular.woff2?inline';
import FrakturBold from 'katex/dist/fonts/KaTeX_Fraktur-Bold.woff2?inline';
import FrakturRegular from 'katex/dist/fonts/KaTeX_Fraktur-Regular.woff2?inline';
import MainBold from 'katex/dist/fonts/KaTeX_Main-Bold.woff2?inline';
import MainBoldItalic from 'katex/dist/fonts/KaTeX_Main-BoldItalic.woff2?inline';
import MainItalic from 'katex/dist/fonts/KaTeX_Main-Italic.woff2?inline';
import MainRegular from 'katex/dist/fonts/KaTeX_Main-Regular.woff2?inline';
import MathBoldItalic from 'katex/dist/fonts/KaTeX_Math-BoldItalic.woff2?inline';
import MathItalic from 'katex/dist/fonts/KaTeX_Math-Italic.woff2?inline';
import SansSerifBold from 'katex/dist/fonts/KaTeX_SansSerif-Bold.woff2?inline';
import SansSerifItalic from 'katex/dist/fonts/KaTeX_SansSerif-Italic.woff2?inline';
import SansSerifRegular from 'katex/dist/fonts/KaTeX_SansSerif-Regular.woff2?inline';
import ScriptRegular from 'katex/dist/fonts/KaTeX_Script-Regular.woff2?inline';
import Size1Regular from 'katex/dist/fonts/KaTeX_Size1-Regular.woff2?inline';
import Size2Regular from 'katex/dist/fonts/KaTeX_Size2-Regular.woff2?inline';
import Size3Regular from 'katex/dist/fonts/KaTeX_Size3-Regular.woff2?inline';
import Size4Regular from 'katex/dist/fonts/KaTeX_Size4-Regular.woff2?inline';
import TypewriterRegular from 'katex/dist/fonts/KaTeX_Typewriter-Regular.woff2?inline';

/**
 * Fontes do KaTeX como `data:` (woff2), SÓ para o arquivo HTML exportado e só quando ele tem
 * fórmula (R-10.4, AC-10.5; sprint R-E1c). A impressão no app usa a folha da mesma origem
 * (`font-src 'self'`). Este módulo é carregado sob demanda pela exportação: nunca entra no bundle
 * principal e nunca faz `fetch` (`connect-src` não tem `'self'`).
 */
const FONTS: Readonly<Record<string, string>> = {
  'KaTeX_AMS-Regular': AMSRegular,
  'KaTeX_Caligraphic-Bold': CaligraphicBold,
  'KaTeX_Caligraphic-Regular': CaligraphicRegular,
  'KaTeX_Fraktur-Bold': FrakturBold,
  'KaTeX_Fraktur-Regular': FrakturRegular,
  'KaTeX_Main-Bold': MainBold,
  'KaTeX_Main-BoldItalic': MainBoldItalic,
  'KaTeX_Main-Italic': MainItalic,
  'KaTeX_Main-Regular': MainRegular,
  'KaTeX_Math-BoldItalic': MathBoldItalic,
  'KaTeX_Math-Italic': MathItalic,
  'KaTeX_SansSerif-Bold': SansSerifBold,
  'KaTeX_SansSerif-Italic': SansSerifItalic,
  'KaTeX_SansSerif-Regular': SansSerifRegular,
  'KaTeX_Script-Regular': ScriptRegular,
  'KaTeX_Size1-Regular': Size1Regular,
  'KaTeX_Size2-Regular': Size2Regular,
  'KaTeX_Size3-Regular': Size3Regular,
  'KaTeX_Size4-Regular': Size4Regular,
  'KaTeX_Typewriter-Regular': TypewriterRegular,
};

/** `src: url(fonts/X.woff2) format("woff2"), url(fonts/X.woff)…` → só o woff2 embutido. */
const FONT_SRC = /src:url\(fonts\/([A-Za-z0-9_-]+)\.woff2\)[^;}]*/g;

/** O CSS do KaTeX (mesma versão do editor) com cada fonte embutida; falha se faltar uma fonte. */
export function katexInlineCss(): string {
  return katexCss.replace(FONT_SRC, (_, name: string) => {
    const data = FONTS[name];
    if (data === undefined) throw new Error(`fonte do KaTeX ausente na exportação: ${name}`);
    return `src:url(${data}) format("woff2")`;
  });
}
