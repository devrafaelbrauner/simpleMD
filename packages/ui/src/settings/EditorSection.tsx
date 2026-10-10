import type { Ref } from 'react';
import { Switch } from '../components/ui/switch';
import { Icon } from '../lib/icons';
import { isMac } from '../lib/platform-keys';

export interface EditorSectionProps {
  /** `editor.captureTab` (r7 U-1, D-40). */
  captureTab: boolean;
  onCaptureTabChange(on: boolean): void;
  /** SED-INVALID: o `config.json` tinha um valor inválido e o padrão está valendo. */
  invalid: boolean;
  /** Foco inicial do L2 nesta seção: o interruptor (SED-OPEN). */
  switchRef?: Ref<HTMLButtonElement>;
}

/**
 * L2 "Editor" (r7 R-X7.1; DESIGN §R7.6.7; STR-157): o interruptor "Tecla Tab no editor" com
 * "Ligado"/"Desligado" e a ajuda em dois parágrafos (o que muda e como sair do editor), que é a
 * descrição do interruptor. Sem pasta, a linha de persistência do diálogo diz que vale só na sessão.
 */
export function EditorSection({
  captureTab,
  onCaptureTabChange,
  invalid,
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
      {invalid && (
        <p className="smd-editor-invalid" data-testid="set-capture-tab-invalid">
          <Icon name="warn" />
          <span>Valor inválido em editor.captureTab; usando “Desligado”.</span>
        </p>
      )}
    </div>
  );
}
