/**
 * Textos do aviso de ativação L6 (product r2 §4.1 M1–M8, arch-ux r2 §3.4; STR-73…76), usados
 * LITERALMENTE: o AC-6.7 e o `docs/plugins.md` conferem estas mesmas frases. Nenhum texto do aviso
 * usa "seguro", "isolado", "verificado" ou "protegido".
 */
export const WARNING_TITLE = 'Ativar um plugin de terceiros?';
export const WARNING_CHANGED_LEAD =
  'O código deste plugin mudou desde a última aprovação neste dispositivo.';
export const WARNING_CANCEL = 'Cancelar';
export const WARNING_ACTIVATE = 'Ativar mesmo assim';

export const WARNING_TEXT = {
  m1: (name: string, id: string, version: string) =>
    `“${name}” (${id}, versão ${version}) não é parte do simpleMD.`,
  m2: 'Ao ativar, o código dele roda dentro do app, com o mesmo acesso que o simpleMD tem. Não existe sandbox.',
  m3: 'Ele pode ler, alterar e criar notas desta pasta.',
  m4: 'Pode executar ações do app, como usar o provedor de IA configurado (com a sua chave e a sua cota).',
  m5: 'Pode ver o que você digita no simpleMD, inclusive uma chave de API enquanto ela é digitada.',
  m6: 'Ative só plugins de quem você confia.',
  m7: 'Se o código do plugin mudar, o simpleMD pede sua confirmação de novo.',
  m8: (main: string, hash12: string) => `Código: ${main} · sha256 ${hash12}…`,
} as const;

/** Palavras que o aviso nunca pode conter (AC-6.7). */
export const WARNING_FORBIDDEN_WORDS = ['seguro', 'isolado', 'verificado', 'protegido'] as const;
