// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { queryTheme } from '../src/tasks/theme';
import { destroyViews, mountedRule, mountView } from './helpers';

/**
 * r7 QA: alerta do W3 sem preenchimento tingido (UIF-04, DESIGN §8.8) e caixa de tarefa do W3 com
 * alvo de 24×24 (F-A11Y-R7-04, WCAG 2.5.8). Contrato do tema sem layout; a geometria e o axe ficam
 * no Playwright do QA. Glossário (EN): alerta = alert; caixa = checkbox; alvo = target.
 */
afterEach(() => destroyViews());

describe('tema do W3 (r7 QA)', () => {
  it('o alerta é barra `danger` de 2 px sobre o quadro, sem fundo próprio (UIF-04)', () => {
    mountView('x', queryTheme);
    const alert = mountedRule('.cm-query-alert');
    expect(alert).toContain('border-inline-start: 2px solid var(--color-danger);');
    expect(alert).not.toMatch(/background/);
  });

  it('a caixa de tarefa ocupa 24×24 com pegada de 1em; a caixa visível de 1em é o `::before` (F-A11Y-R7-04)', () => {
    mountView('x', queryTheme);
    expect(mountedRule('.cm-query-row > .cm-md-task[data-status]')).toBe(
      'width: var(--dimension-space-6); height: var(--dimension-space-6); margin: calc(0.35em - (var(--dimension-space-6) - 1em) / 2) calc((1em - var(--dimension-space-6)) / 2) calc((1em - var(--dimension-space-6)) / 2); border: none; border-radius: calc(var(--dimension-radius) / 2 + (var(--dimension-space-6) - 1em) / 2); background-color: transparent; box-shadow: none;',
    );
    const box = mountedRule('.cm-query-row > .cm-md-task[data-status]::before');
    expect(box).toContain('inset: calc((var(--dimension-space-6) - 1em) / 2);');
    expect(box).toContain('border: 1px solid var(--color-border);');
    expect(mountedRule('.cm-query-row > .cm-md-task[data-status="x"]::before')).toBe(
      'background-color: var(--color-accent); border-color: var(--color-accent);',
    );
    // O anel continua a 2 px da caixa visível, não do alvo.
    expect(mountedRule('.cm-query-row > .cm-md-task[data-status]:focus-visible')).toBe(
      'outline-offset: calc(var(--dimension-focus-ring) - (var(--dimension-space-6) - 1em) / 2);',
    );
  });
});
