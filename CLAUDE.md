# Project Guidelines

Local web UI for AxiDraw / Bantam NextDraw pen plotters. React + Vite frontend, Express backend, drives the plotter via the `nextdraw` CLI subprocess.

See [ARCHITECTURE.md](docs/ARCHITECTURE.md) for data flow, the REST API surface, and the pause/resume mechanism.

## File Structure

```
server/
  index.js         # Express app: routes, SSE, upload, config, layer extraction
  plotter.js       # PlotterManager: state machine + nextdraw subprocess wrangling
db/
  nextdraw.conf.py # nextdraw-native config (edited via the Configure modal)
  uploads/         # Persisted SVGs (git-ignored)
src/
  App.jsx          # Root: reducer wiring, SSE subscription, handlers, sidebar JSX
  Preview.jsx      # Canvas preview (travel area + SVG outline + paths, mm coords)
  FileLibrary.jsx  # File picker modal
  ConfigModal.jsx  # Schema-driven nextdraw config form
  JogPad.jsx       # XY jog arrow pad + home + pen up/down
  LogPanel.jsx     # Scrolling command log
  Modal.jsx        # Shared modal shell
  state.js         # initialState, reducer, localStorage persistence
  App.scss         # All styles
  lib/
    api.js         # fetch wrappers + SSE subscribeStatus
    svg.js         # parseSVG (flatten-svg → mm polylines), PLOTTER_MODELS
docs/
  ARCHITECTURE.md
  reference-apps/  # Vendored saxi sources for reference
```

- Pure/library code lives in `src/lib/`, React components at `src/` root.
- New React components go in their own file at `src/` — keep App.jsx for orchestration.
- All styles go in `src/App.scss`.
- Backend code stays under `server/`. It must not import from `src/`.

## CSS/SCSS Conventions

- Use BEM (Block Element Modifier) naming methodology for CSS classes
- Follow the pattern: `.block__element--modifier`
- Use SCSS nesting with `&` for better organization
- Leverage CSS custom properties for theming

### BEM Example

```scss
.card {
  background: var(--color-bg);
  padding: var(--spacing-2x);

  &__header {
    border-bottom: 1px solid var(--color-text-light);
  }

  &__title {
    font-size: var(--font-size-xl);

    &--large {
      font-size: calc(var(--font-size-xl) * 1.5);
    }
  }
}
```

```jsx
<div className="card">
  <div className="card__header">
    <h2 className="card__title card__title--large">Title</h2>
  </div>
</div>
```
