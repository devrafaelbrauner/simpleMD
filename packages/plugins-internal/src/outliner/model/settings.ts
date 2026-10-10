// Portado de vslinko/obsidian-outliner@b51918d4eaa75223780a404c40f2d9406df6a3c0 (MIT), © 2021 Viacheslav Slinko. Modificado para o simpleMD.
// Origem: src/services/Settings.ts (só os valores que o porte usa). Mudanças: sem armazenamento nem
// aba de configurações (o outliner não tem "Opções", UX-R7-D21): valores fixos nos padrões do
// upstream; `stickCursor` variável só nos testes-ouro que o mudam.

export type KeepCursorWithinContent = 'never' | 'bullet-only' | 'bullet-and-checkbox';

/** Lido a cada operação (os testes-ouro mudam `stickCursor` no meio do caso). */
export interface OutlinerSettings {
  keepCursorWithinContent: KeepCursorWithinContent;
}

export function defaultSettings(): OutlinerSettings {
  return { keepCursorWithinContent: 'bullet-and-checkbox' };
}
