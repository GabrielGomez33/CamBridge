import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { registerSW } from 'virtual:pwa-register';
import './index.css';

// Register the service worker on every route EXCEPT the OBS viewer. The viewer
// is a Browser Source that must always fetch live (no precache/interception),
// and registering a SW there was throwing an "aborted" error in that context.
// registerType is `autoUpdate`, so this self-activates new builds and reloads.
if (!location.pathname.startsWith('/cambridge/viewer')) {
  registerSW({ immediate: true });
}
import Landing from './pages/Landing';
import Broadcaster from './pages/Broadcaster';
import Viewer from './pages/Viewer';
import Contact from './pages/Contact';
import InstallNudges from './components/install/InstallNudges';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {/* basename matches the Apache mount + Vite base (/cambridge) */}
    <BrowserRouter basename="/cambridge">
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/broadcaster" element={<Broadcaster />} />
        <Route path="/viewer" element={<Viewer />} />
        <Route path="/contact" element={<Contact />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      {/* PWA install nudges (Android/desktop one-tap + iOS how-to). Self-gate
          on platform/standalone/dismissal; hidden on the OBS /viewer route.
          The service worker auto-updates (registerType: autoUpdate) via the
          plugin's injected registration — no manual reload banner. */}
      <InstallNudges />
    </BrowserRouter>
  </React.StrictMode>
);
