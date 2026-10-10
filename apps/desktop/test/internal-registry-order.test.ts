// CR-S0-01 (r7 S0): um descritor de `plugins/internal/<id>.ts` importado ANTES do coletor carrega
// sem erro (sem import circular descritor ↔ coletor). Arquivo próprio: a ordem dos imports
// estáticos abaixo é o teste (o descritor é o primeiro módulo do registro a avaliar).
import calc from '../src/plugins/internal/calc';
import { internalPluginDescriptors } from '../src/plugins/internal/index';
import { describe, expect, test } from 'vitest';

describe('registro dos plugins internos: ordem de carga (CR-S0-01)', () => {
  test('descritor importado antes do coletor: mesmo objeto que o coletor devolve', () => {
    expect([calc.id, calc.order, calc.defaultEnabled]).toEqual(['simplemd.calc', 30, true]);
    expect(internalPluginDescriptors()).toContain(calc);
  });
});
