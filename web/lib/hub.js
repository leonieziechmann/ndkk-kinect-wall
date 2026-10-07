// Where is kinect-hub, and which scenes exist? ES module without dependencies (the start page
// uses it too, also when the hub serves it directly).

/**
 * Base URL of the hub, e.g. http://127.0.0.1:8090. Order: ?hub= in the page URL (a port, host:port
 * or URL), the setting of the dev server (KINECT_HUB), the page's own origin when the hub serves it.
 */
export function hubUrl() {
  let h = new URLSearchParams(location.search).get('hub') || window.__KINECT_DEV__?.hub || location.origin;
  if (h === 'same-origin') h = location.origin;
  h = String(h).trim();
  if (/^\d+$/.test(h)) h = `http://127.0.0.1:${h}`;
  else if (!/^https?:\/\//.test(h)) h = `http://${h}`;
  return h.replace(/\/+$/, '');
}

export const wsUrl = (hub = hubUrl()) => `${hub.replace(/^http/, 'ws')}/ws`;

/** The dev server this page comes from (null when the hub serves the page). */
export const devServer = () => (window.__KINECT_DEV__?.url ? window.__KINECT_DEV__ : null);

export async function getJson(url, timeoutMs = 3000) {
  const r = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.json();
}

/** Scenes of this dev server (or of a build), as served at /__scenes. */
export async function localScenes() {
  const list = await getJson('/__scenes');
  return list.scenes ?? [];
}

/** All dev servers known to the hub, each with its scenes; [] if the hub is unreachable. */
export async function allDevServers(hub = hubUrl()) {
  try {
    return (await getJson(`${hub}/api/devservers`)).devservers ?? [];
  } catch {
    return [];
  }
}
