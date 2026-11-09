import { useLayoutEffect, useRef, type Ref } from 'react';
import { Button } from '../components/ui/button';
import { Icon } from '../lib/icons';
import { hotkeyAria, hotkeyLabel } from '../lib/platform-keys';

/** Textos do painel da prévia lado a lado (design-r38 §1). */
export const PREVIEW_PANE_TEXT = {
  title: (name: string) => `Prévia — ${name}`,
  readOnly: 'Só leitura',
  close: 'Fechar prévia',
  content: 'Conteúdo da prévia',
  failed: 'A prévia não pôde ser exibida.',
  unsafe: 'A prévia não pôde ser exibida: conteúdo recusado por segurança.',
  refused: (count: number) =>
    count === 1
      ? '1 bloco não exibido na prévia: conteúdo recusado por segurança.'
      : `${count} blocos não exibidos na prévia: conteúdo recusado por segurança.`,
} as const;

export interface PreviewPaneProps {
  /** Nome da nota mostrada (título "Prévia — nome"). */
  name: string;
  /**
   * Host rolável, vazio no React: o motor da prévia é o único que escreve nele (D-R38-07). Recebe o
   * elemento na montagem e `null` na desmontagem.
   */
  hostRef: Ref<HTMLDivElement>;
  /** Renderização em andamento (`aria-busy` no host). */
  busy: boolean;
  /** Falha da última renderização: `unsafe` (nada inserido) ou `failed` (pipeline). */
  error: 'unsafe' | 'failed' | null;
  /** Blocos recusados no conteúdo mostrado (cada um vira um aviso no lugar dele). */
  refused: number;
  /** Atalho que alterna a prévia (dica e `aria-keyshortcuts` do botão), notação do CodeMirror. */
  closeKey: string;
  /** "Fechar prévia". */
  onClose(): void;
  /**
   * O foco volta ao editor: depois de "Fechar prévia" (o WebKit nem foca o botão no clique) ou quando
   * o painel sai do DOM com o foco dentro dele (tecla, paleta, janela estreita). Uma vez por saída.
   */
  onFocusExit(): void;
}

/**
 * Prévia lado a lado, só leitura (design-r38 §1): região "Prévia — nome" com o selo "Só leitura",
 * "Fechar prévia" e o host do motor (`.smd-doc`, rolável e focável, `contain: layout paint`). Uma
 * região de status, sempre no DOM, diz a falha da renderização ou quantos blocos foram recusados.
 */
export function PreviewPane({
  name,
  hostRef,
  busy,
  error,
  refused,
  closeKey,
  onClose,
  onFocusExit,
}: PreviewPaneProps) {
  const sectionRef = useRef<HTMLElement>(null);
  const exitRef = useRef(onFocusExit);
  /** "Fechar prévia" já devolveu o foco: a saída do DOM não devolve de novo. */
  const exited = useRef(false);

  useLayoutEffect(() => {
    exitRef.current = onFocusExit;
  });

  // A limpeza de layout roda antes de o painel sair do DOM: o foco que estava nele não cai no body.
  useLayoutEffect(() => {
    const section = sectionRef.current;
    return () => {
      if (!exited.current && section?.contains(document.activeElement)) exitRef.current();
    };
  }, []);

  const status =
    error === 'unsafe'
      ? PREVIEW_PANE_TEXT.unsafe
      : error === 'failed'
        ? PREVIEW_PANE_TEXT.failed
        : refused > 0
          ? PREVIEW_PANE_TEXT.refused(refused)
          : '';
  return (
    <section
      ref={sectionRef}
      className="smd-preview"
      aria-labelledby="preview-title"
      data-testid="preview-pane"
    >
      <div className="smd-preview-head">
        <h2 id="preview-title" className="smd-preview-title">
          {PREVIEW_PANE_TEXT.title(name)}
        </h2>
        <span className="smd-preview-badge">{PREVIEW_PANE_TEXT.readOnly}</span>
        <Button
          variant="icon"
          aria-label={PREVIEW_PANE_TEXT.close}
          aria-keyshortcuts={hotkeyAria(closeKey)}
          title={`${PREVIEW_PANE_TEXT.close} (${hotkeyLabel(closeKey)})`}
          data-testid="preview-close"
          onClick={() => {
            exited.current = true;
            onClose();
            onFocusExit();
          }}
        >
          <Icon name="close" />
        </Button>
      </div>
      <p
        role="status"
        className="smd-preview-status"
        data-testid="preview-status"
        data-error={error ?? undefined}
      >
        {status}
      </p>
      <div
        ref={hostRef}
        role="document"
        tabIndex={0}
        aria-label={PREVIEW_PANE_TEXT.content}
        aria-busy={busy || undefined}
        className="smd-preview-host smd-doc"
        data-testid="preview-host"
      />
    </section>
  );
}
