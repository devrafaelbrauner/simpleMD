import type { NoteProperties } from '@simplemd/core';
import { Icon } from '../lib/icons';

export interface PropertiesPanelProps {
  /** Há uma nota aberta na aba ativa. */
  hasTab: boolean;
  properties: NoteProperties;
  /** Cursor na linha da chave e foco no editor. */
  onGo(pos: number): void;
}

/**
 * C4.3 PROPRIEDADES (R-9.4; DESIGN §8.20; UX-R2-D25): só leitura (D-14, 0 campos editáveis). Uma
 * `<ul>` de botões nomeados "<chave>: <valor>"; tags em chips sem `#`; valores longos cortados com
 * "…" e o texto inteiro no `title`. O erro é estático (sem região viva: muda enquanto se digita).
 */
export function PropertiesPanel({ hasTab, properties, onGo }: PropertiesPanelProps) {
  if (!hasTab) return <p className="smd-panel-note">Abra uma nota para ver as propriedades.</p>;
  if (properties.kind === 'too-large') {
    return (
      <p className="smd-panel-warn">
        <Icon name="warn" />
        Front matter maior que 256 KB; não foi lido.
      </p>
    );
  }
  if (properties.kind === 'error') {
    return (
      <div className="smd-ialert smd-props-error" data-testid="props-error">
        <Icon name="warn" />
        <p>
          Front matter inválido: linha {properties.line}: {properties.message}
        </p>
      </div>
    );
  }
  if (properties.kind === 'none' || properties.rows.length === 0) {
    return (
      <div className="smd-panel-note">
        <p className="smd-panel-note-head">Esta nota não tem front matter.</p>
        <p>As propriedades vêm de um bloco YAML entre linhas --- no início da nota.</p>
      </div>
    );
  }
  return (
    <ul aria-label="Propriedades da nota" data-testid="props" className="smd-props">
      {properties.rows.map((row) => (
        <li key={row.key}>
          <button
            type="button"
            className="smd-props-row"
            data-testid="props-row"
            data-key={row.key}
            aria-label={`${row.key}: ${row.full}${row.warning ? ` ${row.warning}` : ''}`}
            onClick={() => onGo(row.pos)}
          >
            <span className="smd-props-key">{row.key}</span>
            {row.chips ? (
              <span className="smd-props-value">
                {row.chips.map((tag) => (
                  <span key={tag} className="smd-chip">
                    {tag}
                  </span>
                ))}
              </span>
            ) : (
              <span
                className="smd-props-value"
                {...(row.display === row.full ? {} : { title: row.full })}
              >
                {row.display}
              </span>
            )}
            {row.warning && (
              <span className="smd-props-warning">
                <Icon name="warn" />
                {row.warning}
              </span>
            )}
          </button>
        </li>
      ))}
    </ul>
  );
}
