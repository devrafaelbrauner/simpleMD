import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { port: 5173, strictPort: true },
  preview: { port: 4173, strictPort: true },
  // Fontes woff2 como arquivos (mesma origem), nunca `data:` (arch-frontend §7.3).
  build: { assetsInlineLimit: (file) => (file.endsWith('.woff2') ? false : undefined) },
});
