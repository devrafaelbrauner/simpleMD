import { useId, type Ref } from 'react';
import { Button } from '../components/ui/button';
import { Switch } from '../components/ui/switch';
import { Icon, type IconName } from '../lib/icons';
import { useDelayed } from '../lib/use-delayed';

/** Status do gerenciador (R-6.20, STR-64). */
export type PluginStatusText =
  'Desativado' | 'Ativo' | 'Erro' | 'Incompatível' | 'Alterado — confirme de novo' | 'Inválido';

/** Uma linha do gerenciador (dados simples: o `packages/ui` não conhece o runtime de plugins). */
export interface PluginRow {
  readonly key: string;
  readonly name: string;
  readonly version: string | null;
  /** Id válido; `null` → "pasta <nome>" (P-STR-4). */
  readonly id: string | null;
  readonly folder: string;
  readonly description: string | null;
  readonly status: PluginStatusText;
  readonly reason: string;
  readonly checked: boolean;
  readonly toggleable: boolean;
  readonly busy: boolean;
}

export interface PluginManagerProps {
  vaultOpen: boolean;
  scan: 'idle' | 'scanning' | 'error';
  internal: readonly PluginRow[];
  external: readonly PluginRow[];
  onReload(): void;
  onToggle(key: string, on: boolean): void;
  reloadRef?: Ref<HTMLButtonElement>;
}

/** Glifo de status (A-29; DESIGN §8.10): o texto sempre aparece, o glifo só reforça. */
const GLYPH: Record<PluginStatusText, { icon: IconName; className: string } | null> = {
  Ativo: { icon: 'check', className: '' },
  Desativado: null,
  Erro: { icon: 'warn', className: 'smd-danger' },
  Inválido: { icon: 'ban', className: 'smd-danger' },
  Incompatível: { icon: 'ban', className: 'smd-muted' },
  'Alterado — confirme de novo': { icon: 'warn', className: '' },
};

const NO_VAULT = 'Abra uma pasta para ver os plugins dela.';

/**
 * L2 seção "Plugins" (R-6.20; arch-ux r2 §3.3; DESIGN §8.14): "Recarregar lista" primeiro, depois
 * "Plugins internos" (sem aviso) e "Plugins desta pasta" em ordem de id.
 */
export function PluginManager(props: PluginManagerProps) {
  const { vaultOpen, scan, internal, external, onReload, onToggle, reloadRef } = props;
  const scanning = scan === 'scanning';
  const showScanning = useDelayed(scanning, 150);
  const slow = useDelayed(scanning, 15_000);
  const reloadDisabled = !vaultOpen || scanning;
  return (
    <div className="smd-plugins" data-testid="plugin-manager">
      <div className="smd-plugins-reload">
        <Button
          ref={reloadRef}
          data-testid="plugin-reload"
          aria-disabled={reloadDisabled || undefined}
          aria-describedby={vaultOpen ? undefined : 'plugin-novault'}
          onClick={onReload}
        >
          <Icon name="refresh" />
          Recarregar lista
        </Button>
      </div>
      {internal.length > 0 && (
        <section className="smd-section" aria-labelledby="plugins-internal-heading">
          <h3 id="plugins-internal-heading" className="smd-section-title">
            Plugins internos
          </h3>
          <p className="smd-hint">
            Fazem parte do simpleMD; ligar ou desligar não pede confirmação.
          </p>
          <ul className="smd-plugin-list">
            {internal.map((row) => (
              <PluginRowView key={row.key} row={row} onToggle={onToggle} />
            ))}
          </ul>
        </section>
      )}
      <section
        className="smd-section"
        aria-labelledby="plugins-vault-heading"
        aria-busy={scanning || undefined}
      >
        <h3 id="plugins-vault-heading" className="smd-section-title">
          Plugins desta pasta
        </h3>
        {!vaultOpen ? (
          <p id="plugin-novault" className="smd-plugins-msg">
            {NO_VAULT}
          </p>
        ) : scan === 'error' ? (
          <div className="smd-ialert" role="alert">
            <Icon name="warn" />
            <div>
              <p>Não foi possível ler a pasta .simplemd/plugins/.</p>
              <div className="smd-ialert-actions">
                <Button variant="ghost" onClick={onReload}>
                  Tentar novamente
                </Button>
              </div>
            </div>
          </div>
        ) : showScanning ? (
          <div className="smd-plugins-msg" role="status">
            <p>Procurando plugins…</p>
            {slow && <p>Isto está demorando mais que o esperado.</p>}
          </div>
        ) : external.length === 0 ? (
          <div className="smd-plugins-msg">
            <p className="smd-plugins-msg-head">Nenhum plugin instalado nesta pasta.</p>
            <p className="smd-muted">
              Para instalar, copie a pasta do plugin (manifest.json e main.js) para{' '}
              <span className="smd-mono">.simplemd/plugins/</span> e clique em “Recarregar lista”.
            </p>
          </div>
        ) : (
          <ul className="smd-plugin-list">
            {external.map((row) => (
              <PluginRowView key={row.key} row={row} onToggle={onToggle} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function PluginRowView({
  row,
  onToggle,
}: {
  row: PluginRow;
  onToggle(key: string, on: boolean): void;
}) {
  const base = useId();
  const statusId = `${base}-status`;
  const reasonId = `${base}-reason`;
  const busy = useDelayed(row.busy, 150);
  const glyph = GLYPH[row.status];
  return (
    <li
      className="smd-plugin-row"
      data-testid="plugin-row"
      data-plugin-id={row.id ?? row.folder}
      data-status={row.status}
      aria-busy={busy || undefined}
    >
      <div className="smd-plugin-text">
        <p className="smd-plugin-line1">
          <span className="smd-plugin-name">{row.name}</span>
          <span className="smd-plugin-status" id={statusId} data-testid="plugin-status">
            <span className="smd-plugin-glyph">
              {glyph && <Icon name={glyph.icon} className={glyph.className} />}
            </span>
            {busy ? 'Ativando…' : row.status}
          </span>
        </p>
        <p className="smd-plugin-meta">
          {row.id === null ? (
            `pasta ${row.folder}`
          ) : (
            <>
              {row.version === null ? '' : `versão ${row.version} · `}
              <span className="smd-mono">{row.id}</span>
            </>
          )}
        </p>
        {row.description && <p className="smd-plugin-desc">{row.description}</p>}
        <p className="smd-plugin-reason" id={reasonId} data-testid="plugin-reason">
          {row.reason}
        </p>
      </div>
      <Switch
        checked={row.checked}
        label={`Ativar “${row.name}”`}
        describedBy={`${statusId} ${reasonId}`}
        disabled={!row.toggleable || row.busy}
        data-testid="plugin-switch"
        onChange={(next) => onToggle(row.key, next)}
      />
    </li>
  );
}
