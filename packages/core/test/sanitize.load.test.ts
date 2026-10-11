// @vitest-environment jsdom
// NFR-54 (r7 bundle): falha do pedaço do sanitizador. O editor não tenta de novo a cada passada
// (a fonte fica como está, com um aviso); a exportação, que espera a carga, tenta de novo.
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.doUnmock('../src/sanitize/sanitizer');
  vi.resetModules();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('NFR-54: falha do pedaço do sanitizador', () => {
  it('pedido do editor falha uma vez e não repete; a carga explícita tenta de novo e funciona', async () => {
    let attempts = 0;
    vi.doMock('../src/sanitize/sanitizer', async (importOriginal) => {
      attempts++;
      if (attempts === 1) throw new Error('pedaço ausente');
      return importOriginal();
    });
    const load = await import('../src/sanitize/load');
    load.requestHtmlSanitizer();
    const pending = load.htmlSanitizerPending();
    expect(pending).not.toBeNull();
    await expect(pending).rejects.toThrow();
    expect(load.loadedHtmlSanitizer()).toBeNull();
    // Depois da falha, o editor não pede de novo (nenhuma carga pendente).
    load.requestHtmlSanitizer();
    expect(load.htmlSanitizerPending()).toBeNull();
    // A exportação pede explicitamente: nova tentativa.
    const sanitizer = await load.loadHtmlSanitizer();
    expect(sanitizer.toExportHtml('<b>ok</b><script>x</script>', () => null, null)).toBe(
      '<b>ok</b>',
    );
    expect(load.loadedHtmlSanitizer()).toBe(sanitizer);
    expect(load.htmlSanitizerPending()).toBeNull();
    expect(attempts).toBe(2);
  });

  it('no editor: o bloco fica como texto e o console avisa uma vez', async () => {
    vi.doMock('../src/sanitize/sanitizer', () => {
      throw new Error('pedaço ausente');
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { createMarkdownExtensions } = await import('../src');
    const load = await import('../src/sanitize/load');
    const doc = '<p>bloco <b>x</b></p>\n\nfim';
    const view = new EditorView({
      parent: document.body.appendChild(document.createElement('div')),
      state: EditorState.create({
        doc,
        selection: { anchor: doc.length },
        extensions: createMarkdownExtensions(),
      }),
    });
    const pending = load.htmlSanitizerPending();
    await expect(pending).rejects.toThrow();
    // O aviso foi registrado no pedido, antes desta espera: já rodou.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('sanitizador do HTML não carregou');
    const frame = view.contentDOM.querySelector<HTMLElement>('[data-testid=html-widget]');
    expect(frame?.textContent).toBe('<p>bloco <b>x</b></p>');
    expect(frame?.querySelector('b')).toBeNull();
    // Um novo desenho depois da falha também fica em texto, sem novo pedido.
    view.dispatch({ changes: { from: doc.length, insert: '!' } });
    expect(load.htmlSanitizerPending()).toBeNull();
    view.destroy();
  });
});
