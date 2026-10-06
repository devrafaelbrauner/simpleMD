import {
  EditorSelection,
  Prec,
  type ChangeSpec,
  type StateCommand,
  type Text,
} from '@codemirror/state';
import { keymap } from '@codemirror/view';

const STAR = '*';

/** Quantos `*` seguidos existem imediatamente antes de `pos`. */
function runBefore(doc: Text, pos: number): number {
  let n = 0;
  while (pos - n > 0 && doc.sliceString(pos - n - 1, pos - n) === STAR) n++;
  return n;
}

/** Quantos `*` seguidos existem imediatamente depois de `pos`. */
function runAfter(doc: Text, pos: number): number {
  let n = 0;
  while (pos + n < doc.length && doc.sliceString(pos + n, pos + n + 1) === STAR) n++;
  return n;
}

/**
 * Alterna marcadores em volta de cada seleção (R-1.2, arch-frontend §2.3). A decisão de
 * remover olha o comprimento das sequências de `*` dos dois lados: negrito está presente
 * quando ambas têm ≥ 2; itálico, quando ambas são ímpares. Assim `**abc**` + itálico vira
 * `***abc***` em vez de perder um `*` e virar itálico.
 */
function toggleMarker(
  size: 1 | 2,
  isPresent: (left: number, right: number) => boolean,
): StateCommand {
  const marker = STAR.repeat(size);
  return ({ state, dispatch }) => {
    if (state.readOnly) return false;
    const tr = state.changeByRange((range) => {
      const left = runBefore(state.doc, range.from);
      const right = runAfter(state.doc, range.to);
      if (isPresent(left, right)) {
        const changes: ChangeSpec[] = [
          { from: range.from - size, to: range.from },
          { from: range.to, to: range.to + size },
        ];
        return {
          changes,
          range: EditorSelection.range(range.anchor - size, range.head - size),
        };
      }
      const changes: ChangeSpec[] = [
        { from: range.from, insert: marker },
        { from: range.to, insert: marker },
      ];
      return {
        changes,
        range: EditorSelection.range(range.anchor + size, range.head + size),
      };
    });
    dispatch(state.update(tr, { scrollIntoView: true, userEvent: 'input.format' }));
    return true;
  };
}

/** `Mod-b`: alterna `**…**`. Seleção vazia insere `****` com o cursor no meio. */
export const toggleBold: StateCommand = toggleMarker(2, (left, right) => left >= 2 && right >= 2);

/** `Mod-i`: alterna `*…*`. Seleção vazia insere `**` com o cursor no meio. */
export const toggleItalic: StateCommand = toggleMarker(
  1,
  (left, right) => left % 2 === 1 && right % 2 === 1,
);

const LINK_URL = 'url';

/**
 * `Mod-k`: com a seleção `abc`, produz `[abc](url)` e seleciona `url`. Com seleção vazia,
 * produz `[](url)` e põe o cursor entre os colchetes.
 */
export const insertLink: StateCommand = ({ state, dispatch }) => {
  if (state.readOnly) return false;
  const tr = state.changeByRange((range) => {
    const changes: ChangeSpec[] = [
      { from: range.from, insert: '[' },
      { from: range.to, insert: `](${LINK_URL})` },
    ];
    if (range.empty) {
      return { changes, range: EditorSelection.cursor(range.from + 1) };
    }
    // Depois da troca: `[` + texto + `](` → a URL começa 3 caracteres após o fim do texto.
    const urlFrom = range.to + 3;
    return { changes, range: EditorSelection.range(urlFrom, urlFrom + LINK_URL.length) };
  });
  dispatch(state.update(tr, { scrollIntoView: true, userEvent: 'input.format' }));
  return true;
};

/** Atalhos de markdown. `Mod` = Cmd no macOS e Ctrl no Windows/Linux. */
export const markdownKeymap = Prec.high(
  keymap.of([
    { key: 'Mod-b', run: toggleBold },
    { key: 'Mod-i', run: toggleItalic },
    { key: 'Mod-k', run: insertLink },
  ]),
);
