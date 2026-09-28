import './csp';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { AuthGate } from './auth';
import './styles.css';

const container = document.getElementById('root');
if (!container) throw new Error('The page has no #root element.');

createRoot(container).render(
  <StrictMode>
    <AuthGate>
      <App />
    </AuthGate>
  </StrictMode>,
);
