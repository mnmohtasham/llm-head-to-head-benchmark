import './csp';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { AuthGate } from './auth';
// uPlot's styles load with the page's own, before them, so the charts' code can come later.
import 'uplot/dist/uPlot.min.css';
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
