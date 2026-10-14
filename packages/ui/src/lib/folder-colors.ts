import type { FolderColorId } from '@simplemd/themes';

/** Rótulos da paleta (STR-R12-02), na ordem fixa de `FOLDER_COLOR_IDS`. Só nomes, nenhum valor. */
export const FOLDER_COLOR_LABELS: Readonly<Record<FolderColorId, string>> = {
  red: 'Vermelho',
  orange: 'Laranja',
  amber: 'Âmbar',
  green: 'Verde',
  teal: 'Azul-petróleo',
  blue: 'Azul',
  violet: 'Violeta',
  pink: 'Rosa',
};

/**
 * Forma falada depois de "cor" (D-R12-09): nome acessível da aba, `role=img` do explorador e
 * anúncio. O adjetivo concorda com "cor" ("cor vermelha"); as demais = rótulo em minúsculas.
 */
export const FOLDER_COLOR_SPOKEN: Readonly<Record<FolderColorId, string>> = {
  red: 'vermelha',
  orange: 'laranja',
  amber: 'âmbar',
  green: 'verde',
  teal: 'azul-petróleo',
  blue: 'azul',
  violet: 'violeta',
  pink: 'rosa',
};
