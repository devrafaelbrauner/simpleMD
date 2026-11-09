import type { EditorMode } from '@simplemd/core';
import type { Ref } from 'react';
import { Switch } from '../components/ui/switch';
import { Icon } from '../lib/icons';
import { isMac } from '../lib/platform-keys';

export interface EditorSectionProps {
  /** `editor.captureTab` (r7 U-1, D-40). */
  captureTab: boolean;
  onCaptureTabChange(on: boolean): void;
  /** SED-INVALID: o `config.json` tinha um valor inválido e o padrão está valendo. */
  captureTabInvalid: boolean;
  /** `editor.defaultMode` (r27b, D-R27-07): modo em que as próximas notas abrem. */
  defaultMode: EditorMode;
  onDefaultModeChange(mode: EditorMode): void;
  /** SED-INVALID de `editor.defaultMode`: "Fonte" está valendo. */
  defaultModeInvalid: boolean;
  /** Foco inicial do L2 nesta seção: o interruptor (SED-OPEN). */
  switchRef?: Ref<HTMLButtonElement>;
}

/**
 * L2 "Editor" (r7 R-X7.1; DESIGN §R7.6.7; STR-157): o interruptor "Tecla Tab no editor" com
 * "Ligado"/"Desligado" e a ajuda em dois parágrafos (o que muda e como sair do editor), que é a
 * descrição do interruptor; depois o select "Ao abrir uma nota" (r27b, D-R27-07), que só vale para
 * as notas abertas depois. Sem pasta, a linha de persistência do diálogo diz que vale só na sessão.
 */
export function EditorSection({
  captureTab,
  onCaptureTabChange,
  captureTabInvalid,
  defaultMode,
  onDefaultModeChange,
  defaultModeInvalid,
  switchRef,
}: EditorSectionProps) {
  return (
    <div className="smd-section" data-testid="settings-editor">
      <div className="smd-field-inline">
        <Switch
          ref={switchRef}
          id="set-capture-tab"
          label="Tecla Tab no editor"
          checked={captureTab}
          describedBy="set-capture-tab-help"
          data-testid="set-capture-tab"
          onChange={onCaptureTabChange}
        />
        <span>Tecla Tab no editor</span>
        <span className="smd-switch-state" aria-hidden="true">
          {captureTab ? 'Ligado' : 'Desligado'}
        </span>
      </div>
      <div id="set-capture-tab-help" className="smd-editor-help">
        <p>
          Desligada: Tab sai do editor e vai para o próximo controle. Ligada: Tab indenta listas,
          passa para a próxima célula de tabela e para o próximo campo de um snippet LaTeX.
        </p>
        <p>
          Com a tecla ligada, para sair do editor: Esc e depois Tab, ou {isMac ? '⌥⇧M' : 'Ctrl+M'}{' '}
          para Tab voltar a mover o foco.
        </p>
      </div>
      {captureTabInvalid && (
        <p className="smd-editor-invalid" data-testid="set-capture-tab-invalid">
          <Icon name="warn" />
          <span>Valor inválido em editor.captureTab; usando “Desligado”.</span>
        </p>
      )}
      <div className="smd-field">
        <label htmlFor="set-default-mode">Ao abrir uma nota</label>
        <select
          id="set-default-mode"
          className="smd-input"
          data-testid="set-default-mode"
          aria-describedby="set-default-mode-hint"
          // Com o valor inválido, nenhum modo aparece escolhido: assim escolher "Fonte" (que já
          // está valendo) também dispara `change`, grava e apaga o aviso (r28 NB-1).
          value={defaultModeInvalid ? '' : defaultMode}
          onChange={(event) =>
            onDefaultModeChange(event.target.value === 'live' ? 'live' : 'source')
          }
        >
          {defaultModeInvalid && (
            <option value="" disabled>
              Fonte (valor inválido no arquivo)
            </option>
          )}
          <option value="source">Fonte (padrão)</option>
          <option value="live">Prévia ao vivo</option>
        </select>
        <span id="set-default-mode-hint" className="smd-hint">
          Vale para as próximas notas; as abas abertas ficam como estão.
        </span>
      </div>
      {defaultModeInvalid && (
        <p className="smd-editor-invalid" data-testid="set-default-mode-invalid">
          <Icon name="warn" />
          <span>Valor inválido em editor.defaultMode; usando “Fonte”.</span>
        </p>
      )}
    </div>
  );
}
