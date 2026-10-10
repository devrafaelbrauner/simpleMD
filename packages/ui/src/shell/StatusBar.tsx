import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { useEffect, useRef, useState } from 'react';
import { Button } from '../components/ui/button';
import { Icon } from '../lib/icons';
import { hotkeyAria, hotkeyLabel } from '../lib/platform-keys';

/** Modo do Vim (S4 escreve o slot; o texto é deste componente, STR-160). */
export type StatusVimMode =
  'normal' | 'insert' | 'visual' | 'visual-line' | 'visual-block' | 'replace';

/** Estado do LanguageTool (S8 escreve o slot; textos STR-166 aqui). */
export type StatusLtView =
  | { readonly state: 'checking' | 'not-found' | 'timeout' | 'manual' }
  | { readonly state: 'issues'; readonly count: number }
  | { readonly state: 'error'; readonly code: string };

/** Itens do menu M2: os dois primeiros vão ao plugin; "Como instalar" é do app. */
export type StatusLtAction = 'retry' | 'check-now' | 'install';

export interface StatusBarProps {
  vim: StatusVimMode | null;
  /** Modo da tecla Tab (só com a "Tecla Tab no editor" ligada). */
  tab: 'indent' | 'focus' | null;
  /** Tecla do alternador em notação do CodeMirror (`Alt-Shift-m` / `Ctrl-m`). */
  tabToggleKey: string;
  lt: StatusLtView | null;
  /** Atalho de "Verificar ortografia e gramática agora" (`Mod-Shift-o`). */
  ltCheckKey: string;
  onLtAction(action: StatusLtAction): void;
}

/** STR-160 (vinculante: maiúsculas, CF-R7-1). */
const VIM_TEXT: Record<StatusVimMode, string> = {
  normal: 'NORMAL',
  insert: 'INSERÇÃO',
  visual: 'VISUAL',
  'visual-line': 'VISUAL LINHA',
  'visual-block': 'VISUAL BLOCO',
  replace: 'SUBSTITUIR',
};

const problems = (count: number) => (count === 1 ? '1 problema' : `${count} problemas`);

/** STR-166 (vinculante). */
export function ltText(lt: StatusLtView): string {
  switch (lt.state) {
    case 'checking':
      return 'LanguageTool: verificando…';
    case 'issues':
      return `LanguageTool: ${problems(lt.count)}`;
    case 'not-found':
      return 'LanguageTool: servidor não encontrado em localhost:8081';
    case 'timeout':
      return 'LanguageTool: sem resposta (tempo esgotado)';
    case 'error':
      return `LanguageTool: erro ${lt.code}`;
    case 'manual':
      return 'LanguageTool: verificação manual';
  }
}

const isFailure = (lt: StatusLtView | null) =>
  lt !== null && (lt.state === 'not-found' || lt.state === 'timeout' || lt.state === 'error');

/** Espera sem nova mudança antes de anunciar a contagem de problemas (UX-R7-D13). */
export const LT_COUNT_SETTLE_MS = 2000;

/**
 * Anúncios do LanguageTool (UX-R7-D13): entrada/saída de falha (texto do indicador), recuperação
 * "LanguageTool voltou: <n> problemas.", contagem depois de 2 s estável; "verificando…" nunca.
 */
function useLtAnnouncement(lt: StatusLtView | null): string {
  const [message, setMessage] = useState('');
  const previous = useRef<StatusLtView | null>(null);
  const announcedCount = useRef<number | null>(null);
  useEffect(() => {
    const before = previous.current;
    previous.current = lt;
    if (lt === null) return;
    if (isFailure(lt)) {
      if (!isFailure(before) || ltText(before as StatusLtView) !== ltText(lt))
        setMessage(ltText(lt));
      return;
    }
    if (lt.state === 'issues') {
      if (isFailure(before)) {
        announcedCount.current = lt.count;
        setMessage(`LanguageTool voltou: ${problems(lt.count)}.`);
        return;
      }
      if (announcedCount.current === lt.count) return;
      const count = lt.count;
      const timer = setTimeout(() => {
        announcedCount.current = count;
        setMessage(`LanguageTool: ${problems(count)}`);
      }, LT_COUNT_SETTLE_MS);
      return () => clearTimeout(timer);
    }
    if (lt.state === 'manual' && isFailure(before)) setMessage(ltText(lt));
  }, [lt]);
  return message;
}

/**
 * Barra de status C6 (r7 DESIGN §R7.6.9, arch-ux §3.8; UX-R7-D11/D13): só existe quando a casca a
 * monta (chave Tab, Vim ou LanguageTool ligados por configuração). Esquerda: modo do Vim (nunca
 * encolhe) e modo do Tab (encolhe depois do LT); direita: botão do LT com o menu M2 acima. A região
 * viva oculta é só do LT; Vim e Tab anunciam pelo editor.
 */
export function StatusBar({ vim, tab, tabToggleKey, lt, ltCheckKey, onLtAction }: StatusBarProps) {
  const announcement = useLtAnnouncement(lt);
  return (
    <div
      role="group"
      aria-label="Barra de status"
      className="smd-statusbar"
      data-testid="status-bar"
    >
      {vim && (
        <span className="smd-status-vim" data-testid="status-vim" data-mode={vim}>
          {VIM_TEXT[vim]}
        </span>
      )}
      {tab && (
        <span className="smd-status-tab" data-testid="status-tab" data-mode={tab}>
          <span className="smd-muted">Tab:</span>
          <span className="smd-status-tab-mode">
            {tab === 'indent' ? ' indenta' : ' move o foco'}
          </span>
          <kbd className="smd-kbd" aria-hidden="true">
            {hotkeyLabel(tabToggleKey)}
          </kbd>
        </span>
      )}
      {lt && <LtButton lt={lt} checkKey={ltCheckKey} onAction={onLtAction} />}
      <p className="sr-only" role="status" data-testid="status-live">
        {announcement}
      </p>
    </div>
  );
}

function LtButton({
  lt,
  checkKey,
  onAction,
}: {
  lt: StatusLtView;
  checkKey: string;
  onAction(action: StatusLtAction): void;
}) {
  const [open, setOpen] = useState(false);
  const text = ltText(lt);
  const failure = isFailure(lt);
  const item = (action: StatusLtAction, label: string, key?: string) => (
    <DropdownMenu.Item
      className="smd-menu-item"
      data-testid={`lt-menu-${action}`}
      {...(key ? { 'aria-keyshortcuts': hotkeyAria(key) } : {})}
      onSelect={() => onAction(action)}
    >
      <span className="smd-menu-label">{label}</span>
      {key && (
        <kbd className="smd-kbd" aria-hidden="true">
          {hotkeyLabel(key)}
        </kbd>
      )}
    </DropdownMenu.Item>
  );
  return (
    <DropdownMenu.Root open={open} onOpenChange={setOpen} modal={false}>
      <DropdownMenu.Trigger asChild>
        <Button
          variant="ghost"
          className="smd-status-lt"
          data-testid="status-lt"
          data-state={lt.state}
          aria-label={text}
          title={text}
        >
          {failure && <Icon name="warn" className="smd-danger smd-status-glyph" />}
          <span className="smd-status-lt-text">{text}</span>
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className="smd-menu"
          data-testid="lt-menu"
          aria-label="LanguageTool"
          side="top"
          align="end"
          sideOffset={4}
          collisionPadding={8}
          loop={false}
        >
          {item('retry', 'Tentar de novo')}
          {item('check-now', 'Verificar ortografia e gramática agora', checkKey)}
          {item('install', 'Como instalar')}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
