// ============================================================================
// InstallNudges — mounts the install bar app-wide, except in OBS
// ============================================================================
// InstallPrompt covers Android/desktop one-tap install (it self-gates on the
// captured `beforeinstallprompt`, which iOS never fires — so there's no install
// bar on iOS, by design: on iOS we stay in the browser rather than nudge users
// to install a home-screen app that can't capture the camera). Mounted once
// globally, but NOT on /viewer — that's the OBS Browser Source, and any overlay
// would bleed into the live scene.
// ============================================================================

import { useLocation } from 'react-router-dom';
import InstallPrompt from './InstallPrompt';

export default function InstallNudges() {
  const { pathname } = useLocation();
  if (pathname.startsWith('/viewer')) return null;
  return <InstallPrompt />;
}
