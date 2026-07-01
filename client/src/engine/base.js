// Mount-agnostic path helpers. The app may be served at a sub-path
// (e.g. /cambridge/broadcaster.html) or at a domain root — derive the API and
// WebSocket bases from the current page location so nothing is hardcoded.

/** The directory the current page is served from, e.g. "/cambridge" or "". */
export function pageBase() {
  return location.pathname.replace(/\/[^/]*$/, '');
}

/** REST API base, e.g. "/cambridge/api". */
export function apiBase() {
  return `${pageBase()}/api`;
}

/** Absolute WebSocket URL for signaling, e.g. "wss://host/cambridge/ws". */
export function wsUrl() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}${pageBase()}/ws`;
}
