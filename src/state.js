/**
 * App state: initial shape, reducer, localStorage persistence.
 */

import { PaperSizes } from "./lib/svg.js";

export const PERSISTED_KEYS = ["selectedFile", "selectedLayer", "paperSize", "paperWidthMm", "paperHeightMm", "marginMm"];
export const STORAGE_KEY = "axya:settings";

function loadPersisted() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) ?? {};
  } catch {
    return {};
  }
}

export const initialState = {
  // Server connection
  serverConnected: false,

  // Plotter status (mirrors backend PlotterManager.status())
  status: {
    state: "idle", // idle | plotting | paused | error
    currentFile: null,
    currentLayer: null,
    progress: 0,
    startedAt: null,
    error: null,
    canHome: false,
    logVersion: 0,
    connected: null, // null=unknown, true=connected, false=no device
  },

  // File library
  files: [],
  selectedFile: null,
  selectedLayer: null,

  // Selected-file derived data (fetched on selection)
  svgString: null,
  paths: null,
  svgWidthMm: 0,
  svgHeightMm: 0,
  layers: [],

  // Config (nextdraw.conf.py contents)
  config: null,

  // Estimate for current file/layer
  estimate: null,

  // Log buffer (from /api/logs)
  logs: [],

  // Paper size
  paperSize: "Letter",
  paperWidthMm: PaperSizes.Letter.width,
  paperHeightMm: PaperSizes.Letter.height,
  marginMm: 12.7, // 0.5 in

  // UI
  error: null,
  showFileLibrary: false,
  showConfig: false,
  showJog: false,
  showLog: false,

  ...loadPersisted(),
};

export function reducer(state, action) {
  switch (action.type) {
    case "SERVER_CONNECTED":
      return { ...state, serverConnected: action.connected };

    case "STATUS":
      return { ...state, status: action.status };

    case "SET_FILES":
      return { ...state, files: action.files };

    case "SELECT_FILE":
      return {
        ...state,
        selectedFile: action.file,
        selectedLayer: null,
        svgString: null,
        paths: null,
        layers: [],
        estimate: null,
      };

    case "SET_SVG":
      return {
        ...state,
        svgString: action.svgString,
        paths: action.paths,
        svgWidthMm: action.widthMm,
        svgHeightMm: action.heightMm,
      };

    case "SET_LAYERS":
      return { ...state, layers: action.layers };

    case "SELECT_LAYER":
      return { ...state, selectedLayer: action.layer, estimate: null };

    case "SET_CONFIG":
      return { ...state, config: action.config };

    case "SET_ESTIMATE":
      return { ...state, estimate: action.estimate };

    case "SET_LOGS":
      return { ...state, logs: action.logs };

    case "SET_ERROR":
      return { ...state, error: action.error };
    case "CLEAR_ERROR":
      return { ...state, error: null };

    case "SET_PAPER_SIZE": {
      const size = PaperSizes[action.size];
      return {
        ...state,
        paperSize: action.size,
        ...(size ? { paperWidthMm: size.width, paperHeightMm: size.height } : {}),
      };
    }
    case "SET_PAPER_WIDTH":
      return { ...state, paperWidthMm: action.value, paperSize: "Custom" };
    case "SET_PAPER_HEIGHT":
      return { ...state, paperHeightMm: action.value, paperSize: "Custom" };
    case "SET_MARGIN":
      return { ...state, marginMm: action.value };

    case "TOGGLE_FILE_LIBRARY":
      return { ...state, showFileLibrary: action.show ?? !state.showFileLibrary };
    case "TOGGLE_CONFIG":
      return { ...state, showConfig: action.show ?? !state.showConfig };
    case "TOGGLE_JOG":
      return { ...state, showJog: action.show ?? !state.showJog };
    case "TOGGLE_LOG":
      return { ...state, showLog: action.show ?? !state.showLog };

    default:
      return state;
  }
}
