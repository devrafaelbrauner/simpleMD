// @vitest-environment jsdom
import '../../../packages/core/test/setup-dom';
import { EditorView } from '@codemirror/view';
import { problemsCommandsFacet } from '@simplemd/core';
import { expect, test } from 'vitest';
import { EditorAssembly } from '../src/editor/assembly';

/**
 * r7 ST (CR-ST-07): plugins aplicados ANTES de o editor montar. Os ouvintes de `onApplied` (os
 * comandos `problems:*` da paleta) são avisados também na montagem e na desmontagem do view.
 */
test('attach avisa os ouvintes: a facet aplicada sem view aparece ao montar e some ao desmontar', () => {
  const assembly = new EditorAssembly(() => {});
  const seen: boolean[] = [];
  assembly.onApplied(() => seen.push(assembly.view?.state.facet(problemsCommandsFacet) != null));
  const commands = { openPanel: () => true, next: () => true, prev: () => true };
  assembly.apply({
    pluginExtensions: [problemsCommandsFacet.of(commands)],
    completionSources: [],
    globalBindings: [],
  });
  const view = new EditorView({ state: assembly.createState('', 'a.md'), parent: document.body });
  assembly.attach(view);
  assembly.attach(null);
  view.destroy();
  expect(seen).toEqual([false, true, false]);
});
