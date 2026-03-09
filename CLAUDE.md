# Project Guidelines

Browser-based AxiDraw pen plotter controller. React + Vite + SCSS. WebSerial only — no server.

See [ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full data flow, EBB protocol notes, and comparison with the vendored saxi reference implementations.

## File Structure

```
src/
  App.jsx          # Root: reducer wiring, pipeline effects, handlers, sidebar JSX
  Preview.jsx      # Canvas preview (paper + paths + progress overlay)
  state.js         # initialState, reducer, localStorage persistence
  App.scss         # All styles
  lib/
    ebb.js         # EiBotBoard WebSerial driver
    planning.js    # Constant-acceleration motion planner
    svg.js         # SVG parse + scale + sort
    vec.js         # 2D vector math
docs/
  ARCHITECTURE.md  # Data flow, EBB protocol notes, saxi comparison
  reference-apps/  # Vendored saxi (nornagon + alexrudd2 forks) for comparison
```

- Pure/library code lives in `src/lib/`, React components at `src/` root.
- New React components go in their own file at `src/` — keep App.jsx for orchestration.
- All styles still go in `src/App.scss`.

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

