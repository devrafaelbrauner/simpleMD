import { createMarkdownExtensions } from '@simplemd/core';
import { applyTheme, type ThemeBase, type Tokens } from '@simplemd/themes';
import { memo, useLayoutEffect, useRef } from 'react';
import { CodeMirrorEditor } from '../editor/CodeMirrorEditor';

export interface ThemePreviewProps {
  /** Tokens resolvidos do rascunho (todos os 37: o que falta vem da base). */
  tokens: Tokens;
  base: ThemeBase;
  /** Documento de exemplo (títulos, ênfase, link, lista, código e tabela; R-5.2). */
  doc: string;
}

/** Lido só na montagem: o editor da prévia nunca é recriado (regra 5). */
const PREVIEW_EXTENSIONS = createMarkdownExtensions({
  readOnly: true,
  livePreview: true,
  ariaLabel: 'Exemplo de documento',
});

/**
 * Prévia do editor de temas (R-5.2, arch-frontend §10): os tokens vão como propriedades inline SÓ
 * neste contêiner, então a raiz do app não muda até salvar (AC-5.2). Cada atualização passa pela
 * janela de supressão de transições (DESIGN §10) e marca `simplemd:preview-updated` (NFR-10).
 */
export const ThemePreview = memo(function ThemePreview({ tokens, base, doc }: ThemePreviewProps) {
  const container = useRef<HTMLDivElement>(null);
  const applied = useRef<Set<string>>(new Set());

  useLayoutEffect(() => {
    if (!container.current) return;
    applied.current = applyTheme(container.current, tokens, applied.current, {
      base,
      mark: 'simplemd:preview-updated',
    });
  }, [tokens, base]);

  return (
    <div
      ref={container}
      role="region"
      aria-label="Pré-visualização do tema"
      tabIndex={0}
      data-testid="theme-preview"
      className="smd-te-preview"
    >
      <div className="smd-te-chrome" aria-hidden="true">
        <span className="smd-te-chrome-side">
          <span className="smd-te-chrome-item">notas</span>
          <span className="smd-te-chrome-item smd-te-chrome-active">exemplo.md</span>
        </span>
        <span className="smd-te-chrome-main">
          Texto com <mark className="smd-te-chrome-selection">seleção</mark>
        </span>
      </div>
      <CodeMirrorEditor
        className="smd-te-editor"
        initialDoc={doc}
        extensions={PREVIEW_EXTENSIONS}
      />
    </div>
  );
});
