import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';

/**
 * AC-10.8 (critério 4 no motor do WebView2, só CI; product §4.4 P3): o harness de produção da
 * exportação servido por `vite preview` e impresso pelo navegador do canal escolhido. No job
 * `export-pdf-windows`, `SIMPLEMD_PDF_CHANNEL=msedge` (o Chromium do WebView2); localmente, sem a
 * variável, o Chromium do Playwright. Saída em `build/export-pdf/` (artefato do CI).
 */
const channel = process.env.SIMPLEMD_PDF_CHANNEL;

export default defineConfig({
  testDir: './e2e',
  testMatch: /\.ci\.spec\.ts$/,
  outputDir: fileURLToPath(new URL('../../build/export-pdf/pw-output', import.meta.url)),
  timeout: 120_000,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    browserName: 'chromium',
    ...(channel ? { channel } : {}),
    baseURL: 'http://localhost:4174',
    trace: 'off',
  },
  webServer: {
    command: 'pnpm preview:harness',
    cwd: fileURLToPath(new URL('.', import.meta.url)),
    url: 'http://localhost:4174',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
