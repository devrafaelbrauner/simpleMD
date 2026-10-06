import '@simplemd/themes/tokens.css';
import '@simplemd/ui/styles/app.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Demo } from './Demo';

const root = document.getElementById('root');
if (!root) throw new Error('elemento #root ausente em index.html');

createRoot(root).render(
  <StrictMode>
    <Demo />
  </StrictMode>,
);
