// ============================================================================
// InstallNudges — mounts the install bars app-wide, except in OBS
// ============================================================================
// InstallPrompt covers Android/desktop one-tap; IOSInstallTutorial covers iOS.
// Both self-gate on platform + standalone + dismissal, so we can mount them
// once globally. The one place we must NOT show them is /viewer — that route
// is the OBS Browser Source, not a page a person browses, so any overlay would
// bleed into the live scene.
// ============================================================================

import { useLocation } from 'react-router-dom';
import InstallPrompt from './InstallPrompt';
import IOSInstallTutorial from './IOSInstallTutorial';

export default function InstallNudges() {
  const { pathname } = useLocation();
  if (pathname.startsWith('/viewer')) return null;
  return (
    <>
      <InstallPrompt />
      <IOSInstallTutorial />
    </>
  );
}
