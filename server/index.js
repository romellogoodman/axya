/**
 * axya backend — Express server that drives the `nextdraw` CLI.
 *
 * Routes under /api:
 *   GET  /status, /events (SSE), /logs
 *   GET  /files, /files/:name, /files/:name/layers
 *   POST /upload, DELETE /files/:name
 *   POST /plot, /pause, /resume, /stop, /home
 *   POST /pen/:dir, /jog
 *   GET  /estimate/:name
 *   GET/POST /config
 */

import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PlotterManager } from "./plotter.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DB_DIR = path.join(ROOT, "db");
const UPLOADS_DIR = path.join(DB_DIR, "uploads");
const CONFIG_PATH = path.join(DB_DIR, "nextdraw.conf.py");

fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const PORT = process.env.AXYA_PORT || 4000;

const plotter = new PlotterManager({
  configPath: CONFIG_PATH,
  uploadsDir: UPLOADS_DIR,
});

const app = express();

// DNS-rebinding / CSRF guard. This server controls physical hardware and binds
// to localhost only, so every request must originate from a localhost page.
// Reject any request whose Host or Origin header is not loopback. Without this,
// a page on any site you visit could fire no-body "simple request" POSTs
// (pause/stop/home/pen) cross-origin and move the carriage or kill a plot.
const LOCALHOST_HOST_RE = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
const LOCALHOST_ORIGIN_RE =
  /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

app.use((req, res, next) => {
  const host = req.headers.host;
  if (host && !LOCALHOST_HOST_RE.test(host)) {
    return res.status(403).json({ error: "Forbidden host" });
  }
  const origin = req.headers.origin;
  if (origin && !LOCALHOST_ORIGIN_RE.test(origin)) {
    return res.status(403).json({ error: "Forbidden origin" });
  }
  next();
});

app.use(express.json());
app.use(express.text({ type: "image/svg+xml", limit: "25mb" }));

// ---- helpers ----
function uniqueUploadName(original) {
  const base = path.basename(original).replace(/[^\w.\- ]+/g, "_");
  let name = base;
  let i = 1;
  while (fs.existsSync(path.join(UPLOADS_DIR, name))) {
    const ext = path.extname(base);
    name = `${path.basename(base, ext)}-${i++}${ext}`;
  }
  return name;
}

// Lightweight SVG validation: the first XML element must be <svg>. Strips the
// optional BOM, XML prolog, DOCTYPE, and leading comments before checking.
function isSvg(text) {
  let s = text.replace(/^﻿/, "").trimStart();
  // Drop prolog / doctype / comments that may precede the root element.
  let prev;
  do {
    prev = s;
    s = s
      .replace(/^<\?xml\b[^>]*\?>/i, "")
      .replace(/^<!DOCTYPE\b[^>]*>/i, "")
      .replace(/^<!--[\s\S]*?-->/, "")
      .trimStart();
  } while (s !== prev);
  return /^<svg[\s>]/i.test(s);
}

function safeUploadPath(name) {
  const p = path.join(UPLOADS_DIR, path.basename(name));
  if (!p.startsWith(UPLOADS_DIR + path.sep)) throw new Error("bad path");
  return p;
}

function listFiles() {
  return fs
    .readdirSync(UPLOADS_DIR)
    .filter((f) => f.toLowerCase().endsWith(".svg"))
    .map((f) => {
      const stat = fs.statSync(path.join(UPLOADS_DIR, f));
      return { name: f, size: stat.size, mtime: stat.mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

// Inkscape layer enumeration: <g inkscape:groupmode="layer" inkscape:label="N - name">
const LAYER_RE =
  /<g\b[^>]*inkscape:groupmode\s*=\s*["']layer["'][^>]*inkscape:label\s*=\s*["']([^"']+)["']/gi;

function extractLayers(svgString) {
  const layers = [];
  let m;
  while ((m = LAYER_RE.exec(svgString))) {
    const label = m[1];
    const numMatch = label.match(/^\s*(\d+)/);
    layers.push({
      label,
      number: numMatch ? Number(numMatch[1]) : null,
    });
  }
  return layers;
}

function wrap(fn) {
  return async (req, res) => {
    try {
      const result = await fn(req, res);
      if (result !== undefined && !res.headersSent) res.json(result);
    } catch (err) {
      plotter.log(err.message, "error");
      res.status(400).json({ error: err.message });
    }
  };
}

// ---- status / events / logs ----
app.get("/api/status", (req, res) => res.json(plotter.status()));

app.get("/api/logs", (req, res) => res.json(plotter.logs));

app.get("/api/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  let lastSent = "";
  const send = () => {
    const status = plotter.status();
    const payload = JSON.stringify(status);
    if (payload !== lastSent) {
      lastSent = payload;
      res.write(`data: ${payload}\n\n`);
    }
  };
  send();

  plotter.on("change", send);
  const keepalive = setInterval(() => res.write(": keepalive\n\n"), 15000);

  req.on("close", () => {
    plotter.off("change", send);
    clearInterval(keepalive);
  });
});

// ---- files ----
app.get("/api/files", (req, res) => res.json(listFiles()));

app.post(
  "/api/upload",
  wrap((req) => {
    const original = req.query.name;
    if (!original || typeof req.body !== "string" || !req.body.length) {
      throw new Error("Missing file name or body");
    }
    // The body is written to disk, fed to the nextdraw CLI, and rendered as an
    // <img>. Only accept content that actually parses as XML with an <svg>
    // root element; a client-side extension check is not enough.
    if (!isSvg(req.body)) {
      throw new Error("Upload is not a valid SVG");
    }
    const name = uniqueUploadName(original);
    fs.writeFileSync(path.join(UPLOADS_DIR, name), req.body);
    plotter.log(`Uploaded ${name}`);
    return { name };
  })
);

app.get(
  "/api/files/:name",
  wrap((req, res) => {
    const p = safeUploadPath(req.params.name);
    res
      .set("Content-Security-Policy", "default-src 'none'; sandbox")
      .type("image/svg+xml")
      .send(fs.readFileSync(p, "utf8"));
  })
);

app.delete(
  "/api/files/:name",
  wrap((req) => {
    const p = safeUploadPath(req.params.name);
    fs.unlinkSync(p);
    plotter.log(`Deleted ${req.params.name}`);
    return { ok: true };
  })
);

app.get(
  "/api/files/:name/layers",
  wrap((req) => {
    const svg = fs.readFileSync(safeUploadPath(req.params.name), "utf8");
    return extractLayers(svg);
  })
);

// ---- plot control ----
app.post(
  "/api/plot",
  wrap((req) => {
    const { file, layer } = req.body || {};
    if (!file) throw new Error("file is required");
    plotter.plot(file, { layer });
    return plotter.status();
  })
);

app.post("/api/pause", wrap(() => (plotter.pause(), plotter.status())));
app.post("/api/resume", wrap(() => (plotter.resume(), plotter.status())));
app.post("/api/stop", wrap(() => (plotter.stop(), plotter.status())));
app.post("/api/home", wrap(async () => (await plotter.home(), plotter.status())));

app.post(
  "/api/pen/:dir",
  wrap(async (req) => {
    await plotter.pen(req.params.dir);
    return { ok: true };
  })
);

app.post(
  "/api/jog",
  wrap(async (req) => {
    const { dx = 0, dy = 0 } = req.body || {};
    await plotter.jog(Number(dx), Number(dy));
    return { ok: true };
  })
);

app.get(
  "/api/estimate/:name",
  wrap((req) => {
    const layer = req.query.layer != null ? Number(req.query.layer) : null;
    return plotter.estimate(req.params.name, layer);
  })
);

// ---- config ----
app.get(
  "/api/config",
  wrap(() => {
    const text = fs.readFileSync(CONFIG_PATH, "utf8");
    const config = {};
    for (const line of text.split("\n")) {
      const m = line.match(/^\s*(\w+)\s*=\s*(.+?)\s*$/);
      if (!m) continue;
      const [, key, raw] = m;
      if (raw === "True") config[key] = true;
      else if (raw === "False") config[key] = false;
      else if (/^-?\d+(\.\d+)?$/.test(raw)) config[key] = Number(raw);
      else config[key] = raw.replace(/^["']|["']$/g, "");
    }
    return config;
  })
);

// The config file is executed as Python by `nextdraw --config`, so both keys
// and values must be strictly validated to prevent code injection.
const CONFIG_BOOL_KEYS = new Set([
  "const_speed",
  "random_start",
  "hiding",
  "auto_rotate",
]);
// Numeric keys with their accepted [min, max] range. The UI enforces these
// client-side only, so a crafted request could otherwise write nonsense like
// speed_pendown=-1e9 or pen_pos_up=99999 into the config the plotter runs.
const CONFIG_NUM_RANGES = {
  model: [1, 10],
  penlift: [1, 3],
  pen_pos_up: [0, 100],
  pen_pos_down: [0, 100],
  pen_rate_raise: [1, 100],
  pen_rate_lower: [1, 100],
  pen_delay_up: [-1000, 10000],
  pen_delay_down: [-1000, 10000],
  speed_pendown: [1, 110],
  speed_penup: [1, 110],
  accel: [1, 100],
  reordering: [0, 4],
  copies: [0, 9999],
  page_delay: [0, 3600],
  resolution: [1, 3],
};
const CONFIG_NUM_KEYS = new Set(Object.keys(CONFIG_NUM_RANGES));

app.post(
  "/api/config",
  wrap((req) => {
    const config = req.body || {};
    const lines = [];
    for (const [k, v] of Object.entries(config)) {
      if (CONFIG_BOOL_KEYS.has(k)) {
        lines.push(`${k} = ${v ? "True" : "False"}`);
      } else if (CONFIG_NUM_KEYS.has(k)) {
        const n = Number(v);
        if (!Number.isFinite(n)) throw new Error(`Invalid value for ${k}`);
        const [min, max] = CONFIG_NUM_RANGES[k];
        if (n < min || n > max) {
          throw new Error(`${k} must be between ${min} and ${max}`);
        }
        lines.push(`${k} = ${n}`);
      } else {
        throw new Error(`Unknown config key: ${k}`);
      }
    }
    fs.writeFileSync(CONFIG_PATH, lines.join("\n") + "\n");
    plotter.log("Config saved");
    return { ok: true };
  })
);

app.listen(PORT, "127.0.0.1", () => {
  console.log(`axya backend listening on http://127.0.0.1:${PORT}`);
});
