/**
 * HTTP client for the axya backend.
 */

async function request(path, opts = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json", ...opts.headers },
    ...opts,
  });
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      if (body.error) msg = body.error;
    } catch {
      // ignore
    }
    throw new Error(msg);
  }
  const ct = res.headers.get("content-type") || "";
  return ct.includes("application/json") ? res.json() : res.text();
}

export const api = {
  status: () => request("/api/status"),
  logs: () => request("/api/logs"),

  files: () => request("/api/files"),
  file: (name) => request(`/api/files/${encodeURIComponent(name)}`),
  layers: (name) => request(`/api/files/${encodeURIComponent(name)}/layers`),
  deleteFile: (name) =>
    request(`/api/files/${encodeURIComponent(name)}`, { method: "DELETE" }),
  upload: async (file) => {
    const body = await file.text();
    return request(`/api/upload?name=${encodeURIComponent(file.name)}`, {
      method: "POST",
      headers: { "Content-Type": "image/svg+xml" },
      body,
    });
  },

  plot: (file, layer) =>
    request("/api/plot", {
      method: "POST",
      body: JSON.stringify({ file, layer }),
    }),
  pause: () => request("/api/pause", { method: "POST" }),
  resume: () => request("/api/resume", { method: "POST" }),
  stop: () => request("/api/stop", { method: "POST" }),
  home: () => request("/api/home", { method: "POST" }),
  pen: (dir) => request(`/api/pen/${dir}`, { method: "POST" }),
  jog: (dx, dy) =>
    request("/api/jog", { method: "POST", body: JSON.stringify({ dx, dy }) }),
  estimate: (name, layer) => {
    const q = layer != null ? `?layer=${layer}` : "";
    return request(`/api/estimate/${encodeURIComponent(name)}${q}`);
  },

  config: () => request("/api/config"),
  saveConfig: (config) =>
    request("/api/config", { method: "POST", body: JSON.stringify(config) }),
};

/**
 * Subscribe to server-sent status events. Auto-reconnects on error.
 * Returns an unsubscribe function.
 */
export function subscribeStatus(onStatus, onConnectionChange) {
  let es = null;
  let reconnectTimer = null;
  let closed = false;

  const connect = () => {
    if (closed) return;
    es = new EventSource("/api/events");
    es.onopen = () => onConnectionChange?.(true);
    es.onmessage = (e) => {
      try {
        onStatus(JSON.parse(e.data));
      } catch {
        // ignore malformed
      }
    };
    es.onerror = () => {
      onConnectionChange?.(false);
      es.close();
      reconnectTimer = setTimeout(connect, 3000);
    };
  };
  connect();

  return () => {
    closed = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    es?.close();
  };
}
