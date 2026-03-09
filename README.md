# Axya

A browser-based pen plotter controller for AxiDraw and Bantam NextDraw plotters.

No installation required — runs entirely in the browser using the WebSerial API. Chrome or Edge only.

## Features

- Direct USB communication with EiBotBoard controllers
- SVG file support with automatic path optimization
- Real-time preview with progress visualization
- Configurable paper sizes, margins, and pen heights
- Auto-reconnect to previously paired devices

## Quick Start

```bash
npm install
npm run dev
```

Open Chrome/Edge, connect your plotter via USB, and drop an SVG file onto the preview area.

## Supported Plotters

- AxiDraw V3
- AxiDraw SE/A3
- Bantam NextDraw 8511, 1117, 2234

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) for data flow, EBB protocol details, and implementation notes.
