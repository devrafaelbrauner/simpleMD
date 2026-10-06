import { EditorView } from '@codemirror/view';
import { createMarkdownExtensions } from '@simplemd/core';
import liveFixture from '@simplemd/core/fixtures/live-preview.md?raw';
import { generateLargeMarkdown } from '@simplemd/core/testing';
import { BUILTIN_THEMES, LIGHT_THEME_ID, applyTheme, resolveTokens } from '@simplemd/themes';
import { CodeMirrorEditor, type CodeMirrorEditorHandle } from '@simplemd/ui';
import { useRef, useState, type ChangeEvent } from 'react';

type DocChoice = 'vazio' | 'fixture';

/** NFR-5: documento de 10.000 linhas, gerado de forma determinística em `?doc=large`. */
const LARGE_DOC_LINES = 10_000;
const LARGE_DOC_SEED = 1;

const DOCS: Record<DocChoice, string> = { vazio: '', fixture: liveFixture };

// A URL é lida uma vez: `?doc=fixture` abre a fixture de live preview e `?doc=large` o documento
// grande (este último não é uma opção do seletor; arch-ux §4.1).
const params = new URLSearchParams(window.location.search);
const docParam = params.get('doc');
const initialChoice: DocChoice = docParam === 'fixture' ? 'fixture' : 'vazio';
const initialDoc =
  docParam === 'large'
    ? generateLargeMarkdown(LARGE_DOC_LINES, LARGE_DOC_SEED)
    : DOCS[initialChoice];

// Na demo o editor ocupa toda a largura, com padding de `space-4` (DESIGN §6, V0). No CodeMirror,
// temas que vêm antes na lista de extensões têm precedência, por isso este vem primeiro.
const editorExtensions = [
  EditorView.theme({ '.cm-content': { maxWidth: 'none', padding: 'var(--dimension-space-4)' } }),
  createMarkdownExtensions({ ariaLabel: 'Editor de markdown' }),
];

// `&theme=simplemd-dark` aplica o escuro embutido já na carga (DEMO-DARK, AC-3.11). O claro é a
// própria tokens.css e não precisa de propriedades inline.
const themeParam = params.get('theme');
const initialTheme = BUILTIN_THEMES.find((theme) => theme.id === themeParam)?.id ?? LIGHT_THEME_ID;
let appliedKeys = new Set<string>();

function applyDemoTheme(id: string): void {
  const theme = BUILTIN_THEMES.find((t) => t.id === id);
  if (!theme) return;
  appliedKeys = applyTheme(document.documentElement, resolveTokens(theme), appliedKeys, {
    base: theme.base,
  });
}

if (initialTheme !== LIGHT_THEME_ID) applyDemoTheme(initialTheme);

export function Demo() {
  const editor = useRef<CodeMirrorEditorHandle>(null);
  const [choice, setChoice] = useState<DocChoice>(initialChoice);
  const [themeId, setThemeId] = useState(initialTheme);

  const onDocChange = (event: ChangeEvent<HTMLSelectElement>) => {
    const next = event.target.value as DocChoice;
    setChoice(next);
    const view = editor.current?.view;
    if (!view) return;
    // Regra 5: o documento muda por dispatch, nunca recriando o editor.
    editor.current?.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: DOCS[next] },
      selection: { anchor: 0 },
    });
  };

  return (
    <main data-testid="demo-root" className="flex h-dvh flex-col bg-bg font-ui text-fg">
      <header className="flex flex-wrap items-end gap-(--dimension-space-4) border-b border-[color-mix(in_srgb,var(--color-border)_45%,var(--color-bg))] p-(--dimension-space-4)">
        <h1 className="mr-auto text-[20px]/[1.3] font-(--fontWeight-semibold) tracking-[-0.005em]">
          simpleMD — demonstração
        </h1>
        <div className="flex flex-col gap-(--dimension-space-1) text-(length:--dimension-ui-font-size)">
          <label htmlFor="demo-fixture">Documento</label>
          <select
            id="demo-fixture"
            data-testid="demo-fixture"
            value={choice}
            onChange={onDocChange}
            className="h-8 rounded-(--dimension-radius) border border-border bg-bg px-(--dimension-space-2) text-fg"
          >
            <option value="vazio">Vazio</option>
            <option value="fixture">Fixture de live preview</option>
          </select>
        </div>
        <div className="flex flex-col gap-(--dimension-space-1) text-(length:--dimension-ui-font-size)">
          <label htmlFor="demo-theme">Tema</label>
          <select
            id="demo-theme"
            data-testid="demo-theme"
            value={themeId}
            onChange={(event) => {
              setThemeId(event.target.value);
              applyDemoTheme(event.target.value);
            }}
            className="h-8 rounded-(--dimension-radius) border border-border bg-bg px-(--dimension-space-2) text-fg"
          >
            {BUILTIN_THEMES.map((theme) => (
              <option key={theme.id} value={theme.id}>
                {theme.name}
              </option>
            ))}
          </select>
        </div>
      </header>
      <CodeMirrorEditor
        ref={editor}
        data-testid="editor"
        className="min-h-0 flex-1"
        initialDoc={initialDoc}
        extensions={editorExtensions}
      />
    </main>
  );
}
