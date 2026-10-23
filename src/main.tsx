import React from 'react';
import ReactDOM from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import App from './ui/App';
import { requestPersistentStorage } from './db/db';
import './styles.css';

// iPad Home Screen apps can sit open for days, so check for a new version whenever
// the app comes back to the screen and every 30 minutes; a new version reloads the app.
registerSW({
  immediate: true,
  onRegisteredSW(_url, registration) {
    if (!registration) return;
    const check = () => {
      if (navigator.onLine) void registration.update().catch(() => undefined);
    };
    document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && check());
    setInterval(check, 30 * 60_000);
  },
});
void requestPersistentStorage();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
