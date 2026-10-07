/**
 * "Copiar" do chat e do cartão (arch-frontend r2 §11.4): `navigator.clipboard.writeText`; se não
 * houver permissão, um `<textarea>` escondido + `execCommand('copy')`. Nenhuma capability de
 * área de transferência do Tauri é adicionada.
 */
export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    // segue para o caminho antigo
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.append(area);
  const active = document.activeElement;
  area.select();
  document.execCommand('copy');
  area.remove();
  if (active instanceof HTMLElement) active.focus();
}
