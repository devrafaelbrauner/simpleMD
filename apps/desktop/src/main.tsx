import '@simplemd/themes/tokens.css';
import '@simplemd/ui/styles/app.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { createAppController } from './app/controller';
import { createTauriPlatform } from './platform/tauri/platform';

const root = document.getElementById('root');
if (!root) throw new Error('elemento #root ausente em index.html');

const app = createAppController(createTauriPlatform());
createRoot(root).render(
  <StrictMode>
    <App app={app} />
  </StrictMode>,
);
