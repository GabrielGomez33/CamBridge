// ============================================================================
// useInstallState — "can the user install CamBridge, and how?"
// ============================================================================
// Ported from the Mirror app's proven install flow, trimmed for CamBridge
// (no push notifications, so no Safari-specific gating). Single source of
// truth for the install nudges:
//
//   isStandalone        launched from a home-screen icon (already installed)
//   isInstallable       browser captured `beforeinstallprompt` (Android /
//                       desktop Chrome/Edge) — one-tap install available
//   isIOS               iOS / iPadOS, any browser
//   isIOSInstallable    iOS in a browser whose share sheet exposes
//                       "Add to Home Screen" (excludes in-app webviews)
//   canPromptInstall    show the Android/desktop one-tap install bar
//   shouldShowIOSTutorial  show the iOS "here's how" bar
//   promptInstall()     fire the captured beforeinstallprompt
//   dismissPromptForever()  persist "don't ask again"
//
// The `beforeinstallprompt` event fires once, before React mounts — so we
// capture it at module scope and fan out to subscribers.
// ============================================================================

import { useCallback, useEffect, useState } from 'react';

// ── module-level capture (event fires before any component mounts) ──────────
interface BeforeInstallPromptEvent extends Event {
  readonly platforms: string[];
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

let capturedPrompt: BeforeInstallPromptEvent | null = null;
const promptListeners = new Set<() => void>();

function notifyPromptListeners(): void {
  for (const fn of promptListeners) {
    try {
      fn();
    } catch {
      /* never let one listener break the others */
    }
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    // Suppress Chrome's default mini-infobar — we surface our own bar.
    e.preventDefault();
    capturedPrompt = e as BeforeInstallPromptEvent;
    notifyPromptListeners();
  });
  window.addEventListener('appinstalled', () => {
    capturedPrompt = null;
    notifyPromptListeners();
  });
}

// ── platform detection ──────────────────────────────────────────────────────
function detectIsIOS(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  // iPadOS 13+ reports as "Macintosh" — disambiguate by touch points.
  const isiPadOS =
    /Macintosh/.test(ua) && typeof navigator.maxTouchPoints === 'number' && navigator.maxTouchPoints > 1;
  return /iPhone|iPad|iPod/.test(ua) || isiPadOS;
}

/**
 * In-app browsers (Instagram, Facebook, TikTok, etc.) embed WebKit but hide
 * the share sheet's "Add to Home Screen" entry — no install path there.
 */
function detectIsIOSInAppBrowser(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  return /FBAN|FBAV|Instagram|Line\/|Twitter|TikTok|Snapchat|MicroMessenger|WeChat/.test(ua);
}

function detectIsIOSInstallable(isIOS: boolean): boolean {
  return isIOS && !detectIsIOSInAppBrowser();
}

function detectIsStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  if (window.matchMedia?.('(display-mode: standalone)').matches) return true;
  if ((navigator as Navigator & { standalone?: boolean }).standalone) return true;
  return false;
}

// ── "don't ask again" persistence (versioned so UX changes can reset it) ────
const DISMISS_KEY = 'cambridge.installBanner.dismissedV1';

function readDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISS_KEY) === '1';
  } catch {
    return false;
  }
}

function writeDismissed(): void {
  try {
    localStorage.setItem(DISMISS_KEY, '1');
  } catch {
    /* private mode / storage full — banner just reappears next visit */
  }
}

// ── hook ─────────────────────────────────────────────────────────────────────
export interface InstallState {
  isStandalone: boolean;
  isInstallable: boolean;
  isIOS: boolean;
  isIOSInstallable: boolean;
  canPromptInstall: boolean;
  shouldShowIOSTutorial: boolean;
  wasDismissed: boolean;
  promptInstall: () => Promise<'accepted' | 'dismissed' | 'unavailable'>;
  dismissPromptForever: () => void;
}

export function useInstallState(): InstallState {
  const [isStandalone, setIsStandalone] = useState<boolean>(detectIsStandalone);
  const [hasPrompt, setHasPrompt] = useState<boolean>(() => capturedPrompt !== null);
  const [wasDismissed, setWasDismissed] = useState<boolean>(readDismissed);
  const [isIOS] = useState<boolean>(detectIsIOS);
  const [isIOSInstallable] = useState<boolean>(() => detectIsIOSInstallable(detectIsIOS()));

  // Subscribe to the module-level prompt lifecycle.
  useEffect(() => {
    const update = () => setHasPrompt(capturedPrompt !== null);
    promptListeners.add(update);
    return () => {
      promptListeners.delete(update);
    };
  }, []);

  // Flip isStandalone if the user installs via the browser's own UI.
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mql = window.matchMedia('(display-mode: standalone)');
    const update = () => setIsStandalone(detectIsStandalone());
    if (mql.addEventListener) {
      mql.addEventListener('change', update);
      return () => mql.removeEventListener('change', update);
    } else if (mql.addListener) {
      mql.addListener(update);
      return () => mql.removeListener(update);
    }
  }, []);

  const promptInstall = useCallback(async (): Promise<'accepted' | 'dismissed' | 'unavailable'> => {
    const prompt = capturedPrompt;
    if (!prompt) return 'unavailable';
    try {
      await prompt.prompt();
      const choice = await prompt.userChoice;
      capturedPrompt = null;
      notifyPromptListeners();
      return choice.outcome;
    } catch {
      capturedPrompt = null;
      notifyPromptListeners();
      return 'dismissed';
    }
  }, []);

  const dismissPromptForever = useCallback(() => {
    writeDismissed();
    setWasDismissed(true);
  }, []);

  return {
    isStandalone,
    isInstallable: hasPrompt,
    isIOS,
    isIOSInstallable,
    canPromptInstall: hasPrompt && !isStandalone && !wasDismissed,
    shouldShowIOSTutorial: isIOSInstallable && !isStandalone && !wasDismissed,
    wasDismissed,
    promptInstall,
    dismissPromptForever,
  };
}
