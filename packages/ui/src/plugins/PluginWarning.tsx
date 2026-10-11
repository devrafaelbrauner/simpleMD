import { useRef } from 'react';
import { AlertDialog } from '../components/ui/alert-dialog';
import { Button } from '../components/ui/button';
import { Icon } from '../lib/icons';
import {
  WARNING_ACTIVATE,
  WARNING_CANCEL,
  WARNING_CHANGED_LEAD,
  WARNING_TEXT,
  WARNING_TITLE,
} from './warning-text';

/** O que o host já leu e hasheou para o aviso (bytes nunca executados antes da confirmação). */
export interface PluginWarningInfo {
  readonly name: string;
  readonly id: string;
  readonly version: string;
  readonly main: string;
  readonly hash12: string;
  /** Código mudou desde a aprovação: mostra STR-75 acima de M1. */
  readonly changed: boolean;
}

export interface PluginWarningProps {
  warning: PluginWarningInfo | null;
  onCancel(): void;
  onActivate(): void;
  /** O aviso saiu do DOM (devolução do foco a quem abriu; ver `AlertDialog.onClosed`). */
  onClosed?: () => void;
}

/**
 * L6 AVISO DE ATIVAÇÃO (R-6.6, product r2 §4.1, arch-ux r2 §3.4, DESIGN §8.15): `alertdialog` com o
 * próprio fundo sobre o L2; foco inicial e Esc em "Cancelar" (primário); clique fora não faz nada;
 * sem ×, sem "não perguntar de novo". O texto M1–M8 é literal (AC-6.7).
 */
export function PluginWarning({ warning, onCancel, onActivate, onClosed }: PluginWarningProps) {
  const cancel = useRef<HTMLButtonElement>(null);
  return (
    <AlertDialog
      open={warning !== null}
      title={WARNING_TITLE}
      initialFocus={cancel}
      onEscape={onCancel}
      onClosed={onClosed}
      className="smd-warning"
      focusableOverflow
      data-testid="plugin-warning"
      description={
        warning && (
          <>
            {warning.changed && (
              <p className="smd-warning-lead">
                <Icon name="warn" />
                <span>{WARNING_CHANGED_LEAD}</span>
              </p>
            )}
            <p>
              “{warning.name}” (<span className="smd-mono">{warning.id}</span>, versão{' '}
              {warning.version}) não é parte do simpleMD.
            </p>
          </>
        )
      }
      footer={
        <>
          <Button data-testid="plugin-warning-activate" onClick={onActivate}>
            {WARNING_ACTIVATE}
          </Button>
          <Button
            ref={cancel}
            variant="primary"
            data-testid="plugin-warning-cancel"
            onClick={onCancel}
          >
            {WARNING_CANCEL}
          </Button>
        </>
      }
    >
      {warning && (
        <>
          <p>{WARNING_TEXT.m2}</p>
          <ul className="smd-warning-list">
            <li>{WARNING_TEXT.m3}</li>
            <li>{WARNING_TEXT.m4}</li>
            <li>{WARNING_TEXT.m5}</li>
          </ul>
          <p className="smd-warning-trust">{WARNING_TEXT.m6}</p>
          <p>{WARNING_TEXT.m7}</p>
          <p className="smd-warning-code">
            Código: {warning.main} · sha256 <span data-testid="warning-hash">{warning.hash12}</span>
            …
          </p>
        </>
      )}
    </AlertDialog>
  );
}
