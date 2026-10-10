// Portado de artisticat1/obsidian-latex-suite@5db51cf36abccdbbfa51184bb5fe86be8157cc2f (MIT), © 2022 artisticat1. Modificado para o simpleMD.
// Origem: src/snippets/codemirror/history.ts. Mudanças: a expansão é UMA transação isolada no
// histórico (JEV D-R7-S6-06), então não há os efeitos start/endSnippet nem o `undo()`/`redo()`
// reentrante do ouvinte de atualização; `invertedEffects` só leva as paradas pelo desfazer
// (encerra) e pelo refazer (restaura), com as posições mapeadas pelo histórico.
import { invertedEffects } from '@codemirror/commands';
import { startStops, undoneStops } from './tabstops';

export const snippetInvertedEffects = invertedEffects.of((tr) => {
  const effects = [];
  for (const effect of tr.effects) {
    if (effect.is(startStops)) effects.push(undoneStops.of(effect.value));
    else if (effect.is(undoneStops)) effects.push(startStops.of(effect.value));
  }
  return effects;
});
