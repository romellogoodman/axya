# axya

Local web UI for AxiDraw / Bantam NextDraw pen plotters. React + Vite frontend, Express backend. The backend drives the plotter through a driver chosen by `AXYA_DRIVER`: `native` (axya's TypeScript port of Bantam's nextdraw driver in `server/driver/`, talking USB serial directly) or `cli` (spawns the `nextdraw` Python CLI; default until the native driver is validated on hardware).

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for data flow, REST API, state machine, and pause/resume mechanics.

The native driver's plan, decisions and verification: [docs/DRIVER_PORT.md](docs/DRIVER_PORT.md). Research on nextdraw, the EBB protocol, saxi and other prior art: [docs/prior-art/](docs/prior-art/README.md). Vendored reference sources live in `docs/reference-apps/` (read-only, lint-ignored).

## Working in this repo

| Command | Does |
|---|---|
| `npm run dev` | Backend (`:4000`) + Vite (`:8080`) together via concurrently |
| `npm run server` / `npm run client` | One side only |
| `npm run lint` | ESLint over `src/` and `server/` — must pass before commit |
| `npm run build` | Production Vite build |
| `npm test` | Node test runner over `test/**/*.test.ts` (driver parity, server, fixtures) |
| `npm run typecheck` | `tsc` over `server/**/*.ts` and `test/**/*.ts` |
| `npm run oracle:setup` / `npm run oracle` | Python venv for, and regeneration of, the nextdraw oracle fixtures |

Verifying changes: the backend can be exercised with `curl http://localhost:4000/api/status` (and the other routes in ARCHITECTURE.md) without a plotter attached. Driver behavior is verified without hardware against a fake EBB (`test/sim/fakeEbb.ts`): `test/run.e2e.test.ts` must reproduce the Python oracle's command stream exactly for every case, and `test/server.native.test.ts` drives `PlotterManager` end to end. Any change under `server/driver/` must keep both green; if nextdraw's behavior is intentionally changed, record it in DRIVER_PORT.md. Real motion needs a USB-connected machine.

## File map

```
server/
  index.js         # Express routes, SSE, upload, config allowlist, layer extraction
  plotter.js       # PlotterManager state machine over a driver
  drivers/         # native.js (NextDraw runs), cli.js (nextdraw subprocesses)
  driver/          # Native driver: TypeScript port of nextdraw 1.7.5 (see NOTICE)
  plotdata.js configFile.js
test/              # node --test suites; oracle/ (Python reference harness), fixtures/, sim/
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

- Native driver code (`server/driver/`) mirrors nextdraw module by module and keeps its snake_case field names; every ported file carries the upstream copyright/license header and an entry in NOTICE. Keep Python semantics (round half-even, float32 points, evaluation order) — parity is tested exactly.
- New React components: own file at `src/` root. App.jsx is orchestration only.
- Pure/non-React helpers: `src/lib/`. Backend never imports from `src/`.
- All styles in `src/App.scss`, BEM naming (`.block__element--modifier`), SCSS `&` nesting, CSS custom properties for theme tokens. Match existing blocks for examples.
- Config keys added to `ConfigModal.jsx` SCHEMA must also be added to the `CONFIG_NUM_KEYS` / `CONFIG_BOOL_KEYS` allowlist in `server/index.js` — the config file is executed as Python, so unvalidated keys are a code-injection vector.
