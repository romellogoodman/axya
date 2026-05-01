# axya

Local web UI for AxiDraw / Bantam NextDraw pen plotters. React + Vite frontend, Express backend; the backend drives the plotter by spawning the `nextdraw` CLI — axya itself contains no motion-planning or serial code.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for data flow, REST API, state machine, and pause/resume mechanics.

## Working in this repo

| Command | Does |
|---|---|
| `npm run dev` | Backend (`:4000`) + Vite (`:8080`) together via concurrently |
| `npm run server` / `npm run client` | One side only |
| `npm run lint` | ESLint over `src/` and `server/` — must pass before commit |
| `npm run build` | Production Vite build |

Verifying changes: the backend can be exercised with `curl http://localhost:4000/api/status` (and the other routes in ARCHITECTURE.md) without a plotter attached. Anything that actually moves hardware — `plot`, `pen`, `jog`, `home` — requires `nextdraw` on PATH and a USB-connected machine; there is no mock.

## File map

```
server/
  index.js         # Express routes, SSE, upload, config allowlist, layer extraction
  plotter.js       # PlotterManager state machine + nextdraw subprocess handling
db/
  nextdraw.conf.py # nextdraw-native config; edited via Configure modal
  uploads/         # Persisted SVGs (git-ignored)
src/
  App.jsx          # Root orchestration: reducer, SSE subscription, handlers, sidebar
  state.js         # initialState + reducer + localStorage persistence (pure)
  Preview.jsx      # Canvas: travel area + SVG outline + paths (mm coords)
  FileLibrary.jsx ConfigModal.jsx JogPad.jsx LogPanel.jsx Modal.jsx
  lib/api.js       # fetch wrappers + SSE subscribeStatus (auto-reconnect)
  lib/svg.js       # parseSVG via flatten-svg → mm polylines; PLOTTER_MODELS table
  App.scss         # All styles
```

## Conventions

- New React components: own file at `src/` root. App.jsx is orchestration only.
- Pure/non-React helpers: `src/lib/`. Backend never imports from `src/`.
- All styles in `src/App.scss`, BEM naming (`.block__element--modifier`), SCSS `&` nesting, CSS custom properties for theme tokens. Match existing blocks for examples.
- Config keys added to `ConfigModal.jsx` SCHEMA must also be added to the `CONFIG_NUM_KEYS` / `CONFIG_BOOL_KEYS` allowlist in `server/index.js` — the config file is executed as Python, so unvalidated keys are a code-injection vector.
