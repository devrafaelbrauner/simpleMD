/**
 * Gerador do vault `FX-2000-TASKS` (product r7 §6; NFR-47, NFR-48). Puro e sem imports, como os
 * outros geradores, determinístico pela semente: 2.000 notas × (20 tarefas + 10 links + 5
 * propriedades). A descrição de cada tarefa tem de 30 a 70 caracteres (média ≈ 50), o perfil com
 * que o backend estimou o índice v3 (arch-backend r7 E-12, C-7): descrições maiores mediriam outro
 * orçamento.
 */
export interface GenerateTasksVaultOptions {
  readonly seed?: number;
  /** Número de notas (padrão 2.000); os testes rápidos usam menos. */
  readonly notes?: number;
}

/** Forma exata de cada nota (product r7 §6). */
export const TASKS_VAULT_COUNTS = {
  notes: 2000,
  perFolder: 100,
  tasksPerNote: 20,
  linksPerNote: 10,
  propertiesPerNote: 5,
  descriptionMin: 30,
  descriptionMax: 70,
} as const;

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

const VERBS = ['Revisar', 'Enviar', 'Escrever', 'Agendar', 'Conferir', 'Organizar', 'Ligar para'];
const WORDS = [
  'relatório',
  'cliente',
  'orçamento',
  'reunião',
  'proposta',
  'contrato',
  'planilha',
  'equipe',
  'fornecedor',
  'entrega',
  'projeto',
  'cronograma',
  'revisão',
  'documento',
  'pagamento',
];
const STATUS = ['ativo', 'pausado', 'concluido', 'ideia'];
const PEOPLE = ['ana', 'bruno', 'carla', 'davi', 'elisa'];
const PRIORITIES = ['🔺', '⏫', '🔼', '🔽', '⏬'];
const TAGS = ['#trabalho', '#casa', '#urgente', '#financeiro'];

const pad = (n: number, width: number) => String(n).padStart(width, '0');
const day = (n: number) => `2026-${pad(10 + (n % 3), 2)}-${pad(1 + (n % 28), 2)}`;

/** Caminho da nota `index` (0-based): `projetos-NN/tarefas-NNNN.md`. */
export function tasksVaultNotePath(index: number): string {
  return `projetos-${pad(Math.floor(index / TASKS_VAULT_COUNTS.perFolder) + 1, 2)}/tarefas-${pad(index + 1, 4)}.md`;
}

/**
 * Gera o vault (`caminho → texto`). Cada nota: front matter com 5 propriedades curtas, 10 links
 * (6 wikilinks pelo nome e 4 links `.md` relativos, para notas existentes) e 20 tarefas com
 * descrição de 30–70 caracteres seguida de sinais (data, prioridade, tag, conclusão, recorrência).
 */
export function generateTasksVault(
  options: GenerateTasksVaultOptions = {},
): Record<string, string> {
  const random = mulberry32(options.seed ?? 11);
  const total = options.notes ?? TASKS_VAULT_COUNTS.notes;
  const pick = <T>(items: readonly T[]) => items[Math.floor(random() * items.length)]!;
  const { descriptionMin: min, descriptionMax: max } = TASKS_VAULT_COUNTS;
  const description = () => {
    const length = min + Math.floor(random() * (max - min + 1));
    let text = pick(VERBS);
    while (text.length < length) text += ` ${pick(WORDS)}`;
    // Corta no tamanho sorteado sem terminar em espaço (o espaço final não é descrição).
    text = text.slice(0, length);
    return text.endsWith(' ') ? `${text.slice(0, -1)}x` : text;
  };
  const vault: Record<string, string> = {};
  for (let i = 0; i < total; i++) {
    const path = tasksVaultNotePath(i);
    const folder = path.slice(0, path.indexOf('/'));
    const lines = [
      '---',
      `status: ${pick(STATUS)}`,
      `prioridade: ${1 + Math.floor(random() * 5)}`,
      `responsavel: ${pick(PEOPLE)}`,
      `prazo: ${day(i)}`,
      `horas: ${1 + Math.floor(random() * 40)}`,
      '---',
      `# Tarefas ${pad(i + 1, 4)}`,
      '',
    ];
    const links: string[] = [];
    for (let k = 0; k < TASKS_VAULT_COUNTS.linksPerNote; k++) {
      const target = (i + 1 + Math.floor(random() * (total - 1))) % total;
      const targetPath = tasksVaultNotePath(target);
      const name = targetPath.slice(targetPath.indexOf('/') + 1, -'.md'.length);
      const sameFolder = targetPath.startsWith(`${folder}/`);
      links.push(
        k < 6
          ? `[[${name}]]`
          : `[${name}](${sameFolder ? targetPath.slice(folder.length + 1) : `../${targetPath}`})`,
      );
    }
    lines.push(`Relacionadas: ${links.join(', ')}.`, '');
    for (let k = 0; k < TASKS_VAULT_COUNTS.tasksPerNote; k++) {
      const n = i * TASKS_VAULT_COUNTS.tasksPerNote + k;
      const done = n % 5 === 0;
      const signs = [
        ...(n % 2 === 0 ? [`📅 ${day(n)}`] : []),
        ...(n % 4 === 1 ? [PRIORITIES[n % PRIORITIES.length]!] : []),
        ...(n % 3 === 0 ? [TAGS[n % TAGS.length]!] : []),
        ...(n % 50 === 7 ? ['🔁 every week'] : []),
        ...(done ? [`✅ ${day(n + 3)}`] : []),
      ];
      lines.push(`- [${done ? 'x' : ' '}] ${[description(), ...signs].join(' ')}`);
    }
    vault[path] = `${lines.join('\n')}\n`;
  }
  return vault;
}
