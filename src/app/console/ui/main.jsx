import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import { AuthGate } from './features/auth/AuthGate.jsx';
import './index.css';

// Vite Fast Refresh (`kusa serve --live` / `npm run dev`): a service worker
// would intercept module URLs and break HMR. Production / plain `kusa serve`
// still registers the PWA shell worker.
if (
  !import.meta.env.DEV
  && typeof navigator !== 'undefined'
  && 'serviceWorker' in navigator
) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {
      /* offline / file:// — splash still works without SW */
    });
  });
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <AuthGate>
      <App />
    </AuthGate>
  </StrictMode>,
);
