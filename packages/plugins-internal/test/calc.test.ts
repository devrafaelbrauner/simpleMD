import { describe, expect, it } from 'vitest';
import { evaluate } from '../src/calc/parse';
import { CALC_MAX_LENGTH, formatResult, renderCalc } from '../src/calc/render';

describe('calc: tabela do AC-7.7', () => {
  it.each([
    ['=2+3', '5'],
    ['=2*(3+4)', '14'],
    ['=10/4', '2.5'],
    ['=0.1+0.2', '0.3'],
    ['=2^10', '1024'],
    ['=7%3', '1'],
    ['=-3+5', '2'],
  ])('%s → %s (nome acessível "<expr> = <resultado>")', (token, text) => {
    expect(renderCalc(token)).toEqual({ text, label: `${token} = ${text}`, error: false });
  });

  it('=1/0 → erro "divisão por zero" (STR-88)', () => {
    expect(renderCalc('=1/0')).toEqual({
      text: 'divisão por zero',
      label: '=1/0: divisão por zero',
      error: true,
    });
    expect(renderCalc('=5%0')?.error).toBe(true);
    expect(renderCalc('=0/0')?.error).toBe(true);
    expect(renderCalc('=2+(3/(1-1))')?.error).toBe(true);
  });

  it.each([
    '=2+',
    '=5',
    '=1e3+1',
    '=',
    '=-3',
    '=(2+3',
    '=2+3)',
    '=2..3+1',
    '=+2+3',
    '=2 +3',
    '=2,5+1',
    '=()',
    '=3.+1',
    '=2**3',
    '=a+1',
  ])('não é calc: %s', (token) => {
    expect(renderCalc(token)).toBeNull();
  });

  it('exatamente 200 caracteres é calc; 202 não é', () => {
    const exact = `=${'1+'.repeat(99)}1`;
    expect(exact.length).toBe(CALC_MAX_LENGTH);
    expect(renderCalc(exact)?.text).toBe('100');
    const long = `=${'1+'.repeat(100)}1`;
    expect(long.length).toBe(CALC_MAX_LENGTH + 2);
    expect(renderCalc(long)).toBeNull();
  });
});

describe('calc: avaliador escrito à mão (D-17)', () => {
  it('precedência, associatividade e menos unário', () => {
    expect(evaluate('2+3*4')).toEqual({ kind: 'value', value: 14 });
    expect(evaluate('2^3^2')).toEqual({ kind: 'value', value: 512 });
    expect(evaluate('-2^2')).toEqual({ kind: 'value', value: -4 });
    expect(evaluate('2^-1')).toEqual({ kind: 'value', value: 0.5 });
    expect(evaluate('--2+1')).toEqual({ kind: 'value', value: 3 });
    expect(evaluate('10-4-3')).toEqual({ kind: 'value', value: 3 });
    expect(evaluate('100/10/5')).toEqual({ kind: 'value', value: 2 });
    expect(evaluate('.5*4')).toEqual({ kind: 'value', value: 2 });
    expect(evaluate('(1+2)*(3+4)')).toEqual({ kind: 'value', value: 21 });
  });

  it('sem operador binário, erro de sintaxe ou resultado não finito → null', () => {
    expect(evaluate('5')).toBeNull();
    expect(evaluate('-5')).toBeNull();
    expect(evaluate('(5)')).toBeNull();
    expect(evaluate('2+')).toBeNull();
    expect(evaluate('10^400')).toBeNull();
    expect(evaluate('(-8)^0.5')).toBeNull();
  });

  it('divisão e resto por zero → div0, mesmo dentro de parênteses', () => {
    expect(evaluate('1/0')).toEqual({ kind: 'div0' });
    expect(evaluate('1%(2-2)')).toEqual({ kind: 'div0' });
  });

  it('formato: até 10 algarismos significativos, sem zeros à direita, sem -0', () => {
    expect(formatResult(0.1 + 0.2)).toBe('0.3');
    expect(formatResult(1 / 3)).toBe('0.3333333333');
    expect(formatResult(2 / 3)).toBe('0.6666666667');
    expect(formatResult(-0)).toBe('0');
    expect(formatResult(1234567890123)).toBe('1234567890000');
    expect(renderCalc('=0*-1')?.text).toBe('0');
  });

  it('avaliação ≤ 1 ms por expressão (NFR-23, mediana de 200)', () => {
    const token = `=${'(1+2)*3-4/5%6^2+'.repeat(11)}1`;
    expect(token.length).toBeLessThanOrEqual(CALC_MAX_LENGTH);
    const samples: number[] = [];
    for (let i = 0; i < 200; i++) {
      const t0 = performance.now();
      renderCalc(token);
      samples.push(performance.now() - t0);
    }
    samples.sort((a, b) => a - b);
    expect(samples[100]).toBeLessThan(1);
  });
});
