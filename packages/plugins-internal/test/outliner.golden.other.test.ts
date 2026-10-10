// Portado de vslinko/obsidian-outliner@b51918d4eaa75223780a404c40f2d9406df6a3c0 (MIT), © 2021 Viacheslav Slinko. Modificado para o simpleMD.
// Origem: specs/features/*.spec.md e specs/services/*.spec.md (casos-ouro), rodados aqui em
// Windows/Linux (o `navigator` do jsdom não é macOS).
import { describe, expect, test } from 'vitest';
import { casePlatforms, checkGolden, loadGoldenCases } from './outliner.harness';

/** AC-I7.1 — casos-ouro do upstream (VimOBehaviourOverride fora, Q-R7-F08), Windows/Linux. */
const cases = loadGoldenCases().filter((c) => casePlatforms(c).includes('other'));

describe('outliner — casos-ouro do upstream (Windows/Linux)', () => {
  test('inventário: 83 casos em Windows/Linux (sem os 7 só de macOS e o de `Cmd-→`)', () => {
    expect(cases).toHaveLength(83);
  });

  test.each(cases.map((c) => [`${c.file} › ${c.title}`, c] as const))('%s', async (_, c) => {
    const checks = await checkGolden(c, 'other');
    expect(checks.length).toBeGreaterThan(0);
    for (const [received, expected] of checks) expect(received).toBe(expected);
  });
});
