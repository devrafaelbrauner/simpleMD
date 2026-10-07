/**
 * Gerador do vault de teste do catálogo (R-9.9; arch-backend r2 §1.4). Puro e sem imports, para o
 * `scripts/gen-vault.mjs` carregar este arquivo direto no Node (MAC) e o harness/VT usarem o mesmo
 * conteúdo: 20 pastas × 100 notas de ~2 KB, determinístico pela semente.
 *
 * Distribuição exata por índice (i % 20): 0 → YAML inválido (5%); 1–4 → só um H1 (20%);
 * 5–19 → front matter com `title`, `tags` (1–4 de um conjunto de 50) e `date` (75%).
 */
export interface GenerateVaultOptions {
  readonly seed?: number;
  readonly folders?: number;
  readonly perFolder?: number;
  /** Texto posto no corpo de TODA nota (teste "o índice não guarda o corpo", AC-9.7). */
  readonly bodySentinel?: string;
}

export type VaultNoteKind = 'front-matter' | 'h1' | 'invalid-yaml';

/** PRNG mulberry32 (o mesmo dos outros geradores). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FOLDERS = [
  'receitas',
  'viagens',
  'projetos',
  'leituras',
  'reunioes',
  'estudos',
  'diario',
  'ideias',
  'finanças',
  'saude',
  'casa',
  'trabalho',
  'musica',
  'cinema',
  'jardim',
  'esportes',
  'codigo',
  'familia',
  'escrita',
  'arquivo',
];

/** 50 tags (inclui `receita`, usada pelos critérios AC-9.9/AC-9.10). */
export const VAULT_TAG_POOL: readonly string[] = [
  'receita',
  'viagem',
  'projeto',
  'leitura',
  'reunião',
  'estudo',
  'diário',
  'ideia',
  'finanças',
  'saúde',
  'casa',
  'trabalho',
  'música',
  'cinema',
  'jardim',
  'esporte',
  'código',
  'família',
  'escrita',
  'arquivo',
  'urgente',
  'rascunho',
  'revisar',
  'pessoal',
  'cliente',
  'livro',
  'artigo',
  'curso',
  'tarefa',
  'meta',
  'doce',
  'salgado',
  'praia',
  'montanha',
  'python',
  'rust',
  'design',
  'ux',
  'marketing',
  'contrato',
  'imposto',
  'treino',
  'corrida',
  'filme',
  'série',
  'podcast',
  'horta',
  'reforma',
  'compras',
  'plano/2026',
];

const TITLE_WORDS = [
  'Receita',
  'Notas',
  'Plano',
  'Resumo',
  'Ideias',
  'Lista',
  'Registro',
  'Anotações',
  'Rascunho',
  'Relato',
];
const TOPICS = [
  'bolo de fubá',
  'pão caseiro',
  'viagem ao sul',
  'projeto Atlas',
  'livro de ensaios',
  'reunião semanal',
  'curso de Rust',
  'orçamento anual',
  'horta da varanda',
  'treino de corrida',
  'reforma da cozinha',
  'filmes do mês',
];
const PROSE = [
  'texto',
  'nota',
  'parágrafo',
  'ideia',
  'linha',
  'valor',
  'prazo',
  'tarefa',
  'conteúdo',
  'exemplo',
  'detalhe',
  'resumo',
  'ação',
  'dúvida',
  'fonte',
];

const pad = (n: number, width: number) => String(n).padStart(width, '0');

/** Tipo de uma nota pelo índice global (a distribuição exata de R-9.9). */
export function vaultNoteKind(index: number): VaultNoteKind {
  const slot = index % 20;
  if (slot === 0) return 'invalid-yaml';
  return slot <= 4 ? 'h1' : 'front-matter';
}

/** Caminho da nota `index` (0-based): `<pasta>/nota-NNN.md`. */
export function vaultNotePath(index: number, perFolder = 100): string {
  const folder = FOLDERS[Math.floor(index / perFolder) % FOLDERS.length] ?? 'pasta';
  const group = Math.floor(index / (perFolder * FOLDERS.length));
  const name = group === 0 ? folder : `${folder}-${group}`;
  return `${name}/nota-${pad((index % perFolder) + 1, 3)}.md`;
}

/**
 * Gera o vault (`caminho → texto`). Mesma semente → mesmos bytes. Cada nota tem ~2 KB de corpo
 * (parágrafos e seções `##`), e as de front matter usam `title`/`tags`/`date` válidos.
 */
export function generateVault(options: GenerateVaultOptions = {}): Record<string, string> {
  const { seed = 9, folders = 20, perFolder = 100, bodySentinel } = options;
  const random = mulberry32(seed);
  const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)] as T;
  const sentence = (n: number) => {
    const words = Array.from({ length: n }, () => pick(PROSE));
    const first = words[0] ?? 'texto';
    words[0] = first.charAt(0).toUpperCase() + first.slice(1);
    return `${words.join(' ')}.`;
  };
  const files: Record<string, string> = {};
  const total = folders * perFolder;
  for (let i = 0; i < total; i++) {
    const title = `${pick(TITLE_WORDS)} ${pick(TOPICS)} ${i + 1}`;
    const lines: string[] = [];
    const kind = vaultNoteKind(i);
    if (kind === 'front-matter') {
      const count = 1 + Math.floor(random() * 4);
      const tags = new Set<string>();
      while (tags.size < count) tags.add(pick(VAULT_TAG_POOL));
      const year = 2024 + Math.floor(random() * 3);
      const month = 1 + Math.floor(random() * 12);
      const day = 1 + Math.floor(random() * 28);
      lines.push(
        '---',
        `title: ${title}`,
        `tags: [${[...tags].join(', ')}]`,
        `date: ${year}-${pad(month, 2)}-${pad(day, 2)}`,
        `autor: Pessoa ${1 + (i % 7)}`,
        '---',
        '',
        `# Cabeçalho do corpo ${i + 1}`,
      );
    } else if (kind === 'h1') {
      lines.push(`# ${title}`);
    } else {
      lines.push('---', `title: [${title}`, 'tags: receita', '---', '', `# ${title}`);
    }
    lines.push('');
    let size = lines.join('\n').length;
    let section = 1;
    while (size < 1900) {
      const block =
        section % 3 === 0
          ? `## Seção ${section}\n\n${sentence(8 + Math.floor(random() * 6))}\n`
          : `${sentence(10 + Math.floor(random() * 10))} ${sentence(8 + Math.floor(random() * 8))}\n`;
      lines.push(block);
      size += block.length + 1;
      section++;
    }
    if (bodySentinel !== undefined) lines.push(bodySentinel, '');
    files[vaultNotePath(i, perFolder)] = lines.join('\n');
  }
  return files;
}
