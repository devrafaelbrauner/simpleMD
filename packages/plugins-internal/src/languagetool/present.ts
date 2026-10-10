import { forceLinting, linter, type Diagnostic } from '@codemirror/lint';
import type { Extension } from '@codemirror/state';
import { EditorSelection } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { problemDiagnostic, type ProblemAction } from '../shared/diagnostics-ui';
import { ltField, ltIgnore, ltRemoveWhere, type LtDiag } from './field';
import { categoryLabel } from './response';

/**
 * Apresentação dos diagnósticos do LT pela UI compartilhada (S5, `shared/diagnostics-ui.ts`;
 * R-I8.5, AC-I8.9): sublinhado ortografia (ondulado `danger`) × gramática/estilo (tracejado `fg`),
 * cartão W2 com até 5 "Trocar por “x”", "Ignorar", "Adicionar ao dicionário" (só ortografia) e
 * "Desativar regra"; rodapé "Regra <ID>". Toda troca é gesto do usuário, numa transação só (um
 * passo de desfazer). Publicado por `linter()` sem `delay` próprio (D-R7-F14), lendo o `ltField`.
 */

export interface LtActions {
  /** Grava a palavra no dicionário pessoal (≤ 10.000); `false` se não coube. */
  addWord(word: string): Promise<boolean>;
  disableRule(ruleId: string): Promise<void>;
  announce(text: string): void;
}

/** Diagnóstico do CM de cada `LtDiag` (o mesmo objeto enquanto o `LtDiag` não muda). */
const cache = new WeakMap<LtDiag, Diagnostic>();

function actionsFor(diag: LtDiag, actions: LtActions): ProblemAction[] {
  const { match } = diag;
  const replace: ProblemAction[] = match.replacements.map((value) => ({
    action: 'replace',
    label: `Trocar por “${value}”`,
    group: 1,
    run(view, from, to) {
      view.dispatch({
        changes: { from, to, insert: value },
        selection: EditorSelection.cursor(from + value.length),
        userEvent: 'input.replace',
        scrollIntoView: true,
      });
      actions.announce(`Trocado por “${value}”.`);
    },
  }));
  const manage: ProblemAction[] = [
    {
      action: 'ignore',
      label: 'Ignorar',
      group: 2,
      run(view) {
        view.dispatch({ effects: ltIgnore.of(diag) });
        actions.announce('Problema ignorado nesta sessão.');
      },
    },
  ];
  if (diag.spelling)
    manage.push({
      action: 'dictionary',
      label: 'Adicionar ao dicionário',
      group: 2,
      run(view) {
        const word = diag.expected;
        view.dispatch({ effects: ltRemoveWhere.of({ word }) });
        void actions.addWord(word).then((added) => {
          if (added) actions.announce(`“${word}” adicionada ao dicionário.`);
        });
      },
    });
  manage.push({
    action: 'disable-rule',
    label: 'Desativar regra',
    name: `Desativar regra ${match.ruleId}`,
    group: 2,
    run(view) {
      view.dispatch({ effects: ltRemoveWhere.of({ ruleId: match.ruleId }) });
      void actions
        .disableRule(match.ruleId)
        .then(() =>
          actions.announce(`Regra ${match.ruleId} desativada. Reative em Configurações → Plugins.`),
        );
    },
  });
  return [...replace, ...manage];
}

export function toDiagnostic(diag: LtDiag, actions: LtActions): Diagnostic {
  const known = cache.get(diag);
  if (known) return known;
  const label = categoryLabel(diag.match);
  const made = problemDiagnostic(diag.from, diag.to, {
    source: 'languagetool',
    kind: diag.spelling ? 'spelling' : 'grammar',
    title: label,
    label,
    body: diag.match.message,
    footer: `Regra ${diag.match.ruleId}`,
    actions: actionsFor(diag, actions),
  });
  cache.set(diag, made);
  return made;
}

/** Fonte do `@codemirror/lint`: só lê o campo (a verificação é do agendador). */
export function ltLinter(actions: LtActions): Extension {
  return linter((view) => view.state.field(ltField).diags.map((d) => toDiagnostic(d, actions)), {
    needsRefresh: (update) =>
      update.startState.field(ltField, false) !== update.state.field(ltField, false),
  });
}

/**
 * Pinta já (NFR-51: ≤ 200 ms depois da resposta) em vez de esperar a espera do lint; também
 * quando uma edição tirou sublinhados tocados (o estado do lint mapearia o sublinhado antigo).
 */
export function repaint(view: EditorView): void {
  queueMicrotask(() => forceLinting(view));
}
