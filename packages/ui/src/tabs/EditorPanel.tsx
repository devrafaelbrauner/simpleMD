import type { ReactNode } from 'react';
import { MOD_LABEL } from '../lib/platform-keys';
import { useDelayed } from '../lib/use-delayed';

/** Grupo do editor (r39b): 0 = o da esquerda (o de sempre), 1 = o da direita do editor dividido. */
export type EditorGroupIndex = 0 | 1;

/** Id DOM do painel do grupo (r39b): `editor-panel`, ou `editor-panel-2` no grupo da direita. */
export const editorPanelDomId = (group: EditorGroupIndex = 0) =>
  group === 0 ? 'editor-panel' : 'editor-panel-2';

export interface EditorPanelProps {
  /** Id DOM da aba ativa; `null` sem abas (o painel some e o estado vazio aparece). */
  labelledBy: string | null;
  /** Nome do arquivo da aba ativa enquanto ele é lido (TAB-OPENING). */
  openingName: string | null;
  /** r39b: grupo do editor (o painel do grupo 1 é `editor-panel-2`). Padrão 0. */
  group?: EditorGroupIndex;
  /** r39b: editor dividido — sem aba, o estado vazio é o do grupo ("Grupo vazio"). */
  split?: boolean;
  /** O `<CodeMirrorEditor>` do grupo: fica sempre montado, só escondido (regra 5). */
  children: ReactNode;
}

const OPENING_DELAY_MS = 150;

/** Painel da aba ativa e estados TAB-NONE (DESIGN §8.9) e "Grupo vazio" (r39b, design-r39 §1). */
export function EditorPanel({
  labelledBy,
  openingName,
  group = 0,
  split = false,
  children,
}: EditorPanelProps) {
  const opening = openingName !== null;
  const showOpening = useDelayed(opening, OPENING_DELAY_MS);
  const hasTabs = labelledBy !== null;
  const panelId = editorPanelDomId(group);
  return (
    <div className="smd-panel">
      {!hasTabs &&
        (split ? (
          <div className="smd-empty" data-testid="group-empty">
            <p className="smd-empty-head">Grupo vazio</p>
            <p>Escolha uma nota no explorador para abrir aqui.</p>
            <p>
              <kbd className="smd-kbd">{`${MOD_LABEL}\\`}</kbd> junta os grupos
            </p>
          </div>
        ) : (
          <div className="smd-empty" data-testid="tabs-empty">
            <p className="smd-empty-head">Nenhum arquivo aberto</p>
            <p>Escolha um arquivo no explorador.</p>
            <p>
              <kbd className="smd-kbd">{MOD_LABEL}O</kbd> abre outra pasta
            </p>
            <p>
              <kbd className="smd-kbd">{MOD_LABEL},</kbd> abre as configurações
            </p>
          </div>
        ))}
      <div
        id={panelId}
        className="smd-panel-host"
        data-testid={panelId}
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
