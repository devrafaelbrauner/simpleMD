// Portado de vslinko/obsidian-outliner@b51918d4eaa75223780a404c40f2d9406df6a3c0 (MIT), © 2021 Viacheslav Slinko. Modificado para o simpleMD.
// Origem: specs/features/*.spec.md e specs/services/*.spec.md (casos-ouro), rodados aqui no
// "macOS" (o CodeMirror lê a plataforma do `navigator` ao carregar: `vi.hoisted` vem antes).
import { describe, expect, test, vi } from 'vitest';
import { casePlatforms, checkGolden, loadGoldenCases, REGULAR_BEHAVIOUR } from './outliner.harness';

vi.hoisted(() => {
  Object.defineProperty(navigator, 'platform', { value: 'MacIntel', configurable: true });
});

/** AC-I7.1 — casos-ouro do upstream (VimOBehaviourOverride fora, Q-R7-F08), plataforma mac. */
const all = loadGoldenCases();
const cases = all.filter((c) => casePlatforms(c).includes('mac'));

describe('outliner — casos-ouro do upstream (mac)', () => {
  test('inventário: 91 casos portados (87 de features sem o Vim `o` + 4 de services), 86 no mac', () => {
    expect(all).toHaveLength(91);
    expect(cases).toHaveLength(86);
    const titles = new Set(all.map((c) => `${c.file} › ${c.title}`));
    for (const key of Object.keys(REGULAR_BEHAVIOUR)) expect(titles).toContain(key);
  });

  test.each(cases.map((c) => [`${c.file} › ${c.title}`, c] as const))('%s', async (_, c) => {
    const checks = await checkGolden(c, 'mac');
    expect(checks.length).toBeGreaterThan(0);
    for (const [received, expected] of checks) expect(received).toBe(expected);
  });
});
