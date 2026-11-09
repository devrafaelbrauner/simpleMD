import type { Ref } from 'react';
import { Switch } from '../components/ui/switch';

export interface FolderSectionProps {
  /** `index.cloudOnly` (r36b): ler — e assim baixar — as notas só na nuvem para indexá-las. */
  cloudOnly: boolean;
  onCloudOnlyChange(on: boolean): void;
  /** Há uma pasta aberta. Sem ela o interruptor fica `aria-disabled`, com o motivo visível. */
  vaultOpen: boolean;
  /**
   * Notas só na nuvem que o índice ainda vai ler com a opção ligada (`cloudDownloads`); 0 esconde
   * a linha "Baixando…".
   */
  downloading: number;
  /** Foco inicial do L2 nesta seção: o interruptor. */
  switchRef?: Ref<HTMLButtonElement>;
}

const HELP_ID = 'set-index-cloud-help';
const NO_VAULT_ID = 'set-index-cloud-novault';

/**
 * L2 "Pasta" (r36c, a última seção; D-R36-8): o interruptor "Indexar notas só na nuvem" com
 * "Ligado"/"Desligado" e a ajuda, que é a descrição dele: o que muda e que, sem conexão, o download
 * é tentado de novo (AppSec r36b N2). Sem pasta ele continua focável, mas fica `aria-disabled` com
 * o motivo visível (a opção é da pasta: `index.cloudOnly` no `config.json`). Enquanto o índice baixa
 * notas para indexar, uma linha diz quantas faltam (code-review r36b, item 5).
 */
export function FolderSection({
  cloudOnly,
  onCloudOnlyChange,
  vaultOpen,
  downloading,
  switchRef,
}: FolderSectionProps) {
  return (
    <div className="smd-section" data-testid="settings-folder">
      <div className="smd-field-inline">
        <Switch
          ref={switchRef}
          id="set-index-cloud"
          label="Indexar notas só na nuvem"
          checked={cloudOnly}
          disabled={!vaultOpen}
          describedBy={vaultOpen ? HELP_ID : `${NO_VAULT_ID} ${HELP_ID}`}
          data-testid="set-index-cloud"
          onChange={onCloudOnlyChange}
        />
        <span>Indexar notas só na nuvem</span>
        <span className="smd-switch-state" aria-hidden="true">
          {cloudOnly ? 'Ligado' : 'Desligado'}
        </span>
      </div>
      {!vaultOpen && (
        <p id={NO_VAULT_ID} className="smd-hint">
          Abra uma pasta para escolher como as notas dela são indexadas.
        </p>
      )}
      <div id={HELP_ID} className="smd-editor-help">
        <p>
          Desligado: as notas que o OneDrive, o Proton Drive ou outro cliente de sincronização
          deixou só na nuvem entram no catálogo só pelo nome, sem ser baixadas. Ligado: o simpleMD
          lê essas notas para indexar título, tags e links, e o sistema as baixa para este
          computador.
        </p>
        <p>
          Sem conexão, as que não baixarem ficam só pelo nome e o download é tentado de novo a cada
          verificação da pasta. Abrir uma nota no editor sempre a baixa.
        </p>
      </div>
      {downloading > 0 && (
        <p className="smd-hint" data-testid="set-index-cloud-downloading">
          Baixando {downloading.toLocaleString('pt-BR')} {downloading === 1 ? 'nota' : 'notas'} da
          nuvem para indexar…
        </p>
      )}
    </div>
  );
}
