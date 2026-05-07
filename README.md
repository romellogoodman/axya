# Axya

> ⚠️ **Alpha** — expect rough edges, breaking changes, and bugs. Feedback welcome.

A local web interface for AxiDraw and Bantam NextDraw pen plotters.

Axya runs a small Node server alongside a React frontend. The server drives your plotter by shelling out to Bantam's official [`nextdraw` CLI](https://bantam.tools/nd_cli/), which handles all motion planning, path optimization, and hardware communication for both AxiDraw and NextDraw machines.

## Features

- **File library** — upload and manage SVGs, they persist on disk
- **Canvas preview** — see paths against your plotter's travel area before committing
- **Inkscape layer mode** — plot one numbered layer at a time for multi-pen work
- **Pause / Resume** — survives a page reload; state is saved into the SVG by `nextdraw`
- **Stop & Home** — cancel cleanly and return the carriage
- **Manual XY jog + pen up/down** — align your pen before plotting
- **Time estimate** — duration and travel distance before you commit
- **Live progress + ETA** — elapsed, percentage, time remaining
- **Web Notifications** — get pinged when a plot completes, pauses, or errors
- **Full config UI** — model, pen positions, speeds, path reordering, random start, hidden-line removal, copies
- **Command log panel** — see every `nextdraw` invocation and its output

## Prerequisites

### 1. Node.js 18+

### 2. The `nextdraw` CLI

Axya delegates all plotter control to Bantam's CLI. It must be installed and on your `PATH`:

```bash
python3 -m pip install https://software-download.bantamtools.com/nd/api/nextdraw_api.zip
nextdraw --version
```

The `nextdraw` CLI supports **both** product lines: AxiDraw models 1–7 (V2/V3, SE/A3, XLX, MiniKit, SE/A1, SE/A2, V3/B6) and Bantam NextDraw models 8–10 (8511, 1117, 2234). Full reference: [bantam.tools/nd_cli](https://bantam.tools/nd_cli/). If migrating from `axicli`, see the [migration guide](https://bantam.tools/nd_migrate/).

> If `nextdraw` isn't on your PATH (e.g. it lives in a virtualenv), set `NEXTDRAW_CMD=/full/path/to/nextdraw` before starting the server.

## Quick Start

```bash
npm install
npm run dev
```

This starts both the backend (port 4000) and the Vite dev server (port 8080) and opens a browser. Plug in your plotter, open **Configure** to pick your model, drop an SVG onto the preview, and hit **Plot**.

## How it works

```
Browser (React) ──REST+SSE──▶ Node/Express ──spawn──▶ nextdraw CLI ──USB──▶ plotter
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for details.

## Acknowledgments

- [nextdraw API](https://bantam.tools/nd_py/) by Bantam Tools / Evil Mad Scientist — the actual plotter driver
- [penplotter-web](https://github.com/gre/penplotter-web) by @gre — the CLI-wrapper architecture and several UX patterns
- [saxi](https://github.com/nornagon/saxi) by @nornagon and [alexrudd2's fork](https://github.com/alexrudd2/saxi) — the original inspiration and reference implementations

## License

GNU Affero General Public License v3.0 — see [LICENSE](LICENSE).
