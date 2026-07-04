// ============================================================================
// InstallPrompt — Android / desktop one-tap install bar
// ============================================================================
// Shown when the browser captured `beforeinstallprompt` (Android Chrome/Edge,
// desktop Chrome/Edge), the app isn't already standalone, and the user hasn't
// dismissed forever. Tapping "Install" fires the native prompt. Styled in
// CamBridge's terminal aesthetic.
// ============================================================================

import { useState } from 'react';
import { useInstallState } from '../../hooks/useInstallState';
import { InstallCard } from './InstallCard';

export default function InstallPrompt() {
  const { canPromptInstall, promptInstall, dismissPromptForever } = useInstallState();
  const [hiddenThisSession, setHiddenThisSession] = useState(false);
  const [busy, setBusy] = useState(false);

  if (!canPromptInstall || hiddenThisSession) return null;

  const handleInstall = async () => {
    setBusy(true);
    try {
      const outcome = await promptInstall();
      if (outcome === 'dismissed') setHiddenThisSession(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <InstallCard
      subtitle="Add CamBridge to your home screen — full-screen, and one tap to go live."
      onClose={() => setHiddenThisSession(true)}
      primary={{ label: busy ? 'Installing…' : 'Install', onClick: handleInstall, disabled: busy }}
      onDontAsk={() => {
        dismissPromptForever();
        setHiddenThisSession(true);
      }}
    />
  );
}
