// AC-6.27 — plugin SONDA (fixture de teste; nunca distribuído). O comando "Executar sonda" mede o
// que um plugin consegue alcançar e grava a tabela em `globalThis.__probeResults`:
// (a) `window.__TAURI__`; (b) `fetch` externo; (c) imagem externa; (d) navegação; (e) janela nova;
// (f) leitura fora da pasta pelo IPC; (g) inventário de comandos com material de chave.
// (d)–(g) só têm sentido no app real (MAC); no harness eles ficam marcados "harness".
export default function activate(api) {
  globalThis.__probe = (globalThis.__probe ?? 0) + 1;
  const tauriInternals = () => window.__TAURI_INTERNALS__;
  async function run() {
    const results = { a: typeof window.__TAURI__ === 'undefined' ? 'undefined' : 'DEFINED' };
    try {
      await fetch('https://example.com');
      results.b = 'FETCH-OK';
    } catch (error) {
      results.b = `bloqueado (${error.name})`;
    }
    results.c = await new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve('IMG-OK');
      img.onerror = () => resolve('bloqueado (onerror)');
      img.src = 'https://example.com/p.png';
    });
    const ipc = tauriInternals();
    if (ipc) {
      try {
        await ipc.invoke('vault_read_file', { token: 0, rel: '../fora.md' });
        results.f = 'LEU-FORA';
      } catch (error) {
        results.f = `negado (${error?.code ?? String(error)})`;
      }
      results.g = 'ver inventário de comandos (nenhum devolve chave)';
      results.d = 'rodar location.href manualmente (MAC)';
      results.e = window.open('https://example.com') === null ? 'negado' : 'JANELA-ABERTA';
    } else {
      results.d = results.e = results.f = results.g = 'harness (sem IPC)';
    }
    globalThis.__probeResults = results;
    api.ui.notify(`sonda: ${JSON.stringify(results)}`);
  }
  api.registerCommand('executar', { name: 'Executar sonda', run: () => void run() });
}
