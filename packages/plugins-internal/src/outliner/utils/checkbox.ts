// Portado de vslinko/obsidian-outliner@b51918d4eaa75223780a404c40f2d9406df6a3c0 (MIT), © 2021 Viacheslav Slinko. Modificado para o simpleMD.
// Origem: src/utils/checkboxRe.ts e src/utils/isEmptyLineOrEmptyCheckbox.ts (juntos num arquivo).

/** Caixa de tarefa no início do conteúdo de um item (`[ ] `, `[x] `, `[!] `…). */
export const checkboxRe = `\\[[^\\[\\]]\\][ \t]`;

/** Conteúdo vazio ou só uma caixa vazia: Enter desindenta/encerra em vez de criar item. */
export function isEmptyLineOrEmptyCheckbox(line: string): boolean {
  return line === '' || line === '[ ] ';
}
