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

See [ARCHITECTURE.md](docs/ARCHITECTURE.md) for data flow, EBB protocol details, and implementation notes.

## Acknowledgments

Axya is based on [saxi](https://github.com/nornagon/saxi) by nornagon, with additional reference to [alexrudd2's fork](https://github.com/alexrudd2/saxi). Thank you for the foundational work on motion planning and EBB protocol implementation.

## License

GNU Affero General Public License v3.0 - see [LICENSE](LICENSE) for details.
