import type { ReactNode } from 'react';
import { MOD_LABEL } from '../lib/platform-keys';
import { useDelayed } from '../lib/use-delayed';

export interface EditorPanelProps {
  /** Id DOM da aba ativa; `null` sem abas (o painel some e o estado vazio aparece). */
  labelledBy: string | null;
  /** Nome do arquivo da aba ativa enquanto ele é lido (TAB-OPENING). */
  openingName: string | null;
  /** O único `<CodeMirrorEditor>` da sessão: fica sempre montado, só escondido (regra 5). */
  children: ReactNode;
}

const OPENING_DELAY_MS = 150;

/** Painel da aba ativa e estado TAB-NONE (DESIGN §8.9). */
export function EditorPanel({ labelledBy, openingName, children }: EditorPanelProps) {
  const opening = openingName !== null;
  const showOpening = useDelayed(opening, OPENING_DELAY_MS);
  const hasTabs = labelledBy !== null;
  return (
    <div className="smd-panel">
      {!hasTabs && (
        <div className="smd-empty" data-testid="tabs-empty">
          <p className="smd-empty-head">Nenhum arquivo aberto</p>
          <p>Escolha um arquivo no explorador.</p>
          <p>
            <kbd className="smd-kbd">{MOD_LABEL}O</kbd> abre outra pasta
          </p>
        </div>
      )}
      <div
        id="editor-panel"
        className="smd-panel-host"
        data-testid="editor-panel"
        role={hasTabs ? 'tabpanel' : undefined}
        aria-labelledby={labelledBy ?? undefined}
        aria-busy={opening || undefined}
        hidden={!hasTabs}
      >
        {showOpening && <p className="smd-panel-msg">Abrindo “{openingName}”…</p>}
        <div className="smd-panel-host" hidden={opening}>
          {children}
        </div>
      </div>
    </div>
  );
}
