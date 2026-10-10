/**
 * Arquivos de configuração do vault que plugins internos leem (r7 arch-backend §1.13, D-R7-B18):
 * lista FECHADA com teto por arquivo, só leitura. `toVaultPath` continua recusando qualquer
 * segmento oculto; só estes 3 caminhos constantes passam, por `readConfigFile` e pelo `watch`.
 * `.markdownlint.yaml/.yml/.cjs/.js/.mjs` não estão aqui: não existe caminho de código que os leia.
 */
export const VAULT_CONFIG_FILES = {
  '.markdownlint.json': 64 * 1024,
  '.markdownlint.jsonc': 64 * 1024,
  '.simplemd/latex-snippets.json': 256 * 1024,
} as const;

export type VaultConfigFile = keyof typeof VAULT_CONFIG_FILES;

/** `path` é exatamente um dos arquivos da lista? */
export function isVaultConfigFile(path: string): path is VaultConfigFile {
  return Object.hasOwn(VAULT_CONFIG_FILES, path);
}
