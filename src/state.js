/**
 * App state: initial shape, reducer, localStorage persistence.
 */

// Settings to persist across sessions
export const PERSISTED_KEYS = [
  "paperSize",
  "paperWidth",
  "paperHeight",
  "marginMm",
  "fitPage",
  "penUpHeight",
  "penDownHeight",
];
export const STORAGE_KEY = "axya:settings";

function loadPersisted() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) ?? {};
  } catch {
    return {};
  }
}

export const initialState = {
  // Connection state
  connected: false,
  ebb: null,
  firmwareVersion: null,
  steppersPowered: false,

  // SVG state
  svgString: null,
  svgFileName: null,
  rawPaths: null, // Paths in SVG coordinates
  scaledPaths: null, // Paths in plotter step coordinates
  svgWidth: 0,
  svgHeight: 0,
  svgViewBox: null,

  // Planning state
  plan: null,
  estimatedDuration: null,

  // Paper configuration
  paperSize: "AxiDraw V3",
  paperWidth: 300,
  paperHeight: 218,
  marginMm: 20,
  fitPage: true,

  // Pen configuration
  penUpHeight: 50,
  penDownHeight: 60,

  // Plotting state
  plotting: false,
  progress: 0, // 0 to 1
  currentMotion: 0,
  totalMotions: 0,

  // Error state
  error: null,

  // Restore persisted settings on top of defaults
  ...loadPersisted(),
};

export function reducer(state, action) {
  switch (action.type) {
    case "CONNECTED":
      return {
        ...state,
        connected: true,
        ebb: action.ebb,
        firmwareVersion: action.firmwareVersion,
        steppersPowered: action.steppersPowered,
        error: null,
      };
    case "DISCONNECTED":
      return {
        ...state,
        connected: false,
        ebb: null,
        firmwareVersion: null,
        steppersPowered: false,
      };
    case "SET_SVG":
      return {
        ...state,
        svgString: action.svgString,
        svgFileName: action.fileName,
        rawPaths: action.paths,
        svgWidth: action.width,
        svgHeight: action.height,
        svgViewBox: action.viewBox,
        scaledPaths: null,
        plan: null,
        estimatedDuration: null,
      };
    case "SET_SCALED_PATHS":
      return {
        ...state,
        scaledPaths: action.paths,
      };
    case "SET_PLAN":
      return {
        ...state,
        plan: action.plan,
        estimatedDuration: action.duration,
      };
    case "SET_PAPER_SIZE":
      return {
        ...state,
        paperSize: action.paperSize,
        paperWidth: action.width,
        paperHeight: action.height,
        scaledPaths: null,
        plan: null,
      };
    case "SET_PAPER_WIDTH":
      return {
        ...state,
        paperSize: "",
        paperWidth: action.width,
        scaledPaths: null,
        plan: null,
      };
    case "SET_PAPER_HEIGHT":
      return {
        ...state,
        paperSize: "",
        paperHeight: action.height,
        scaledPaths: null,
        plan: null,
      };
    case "SET_MARGIN":
      return {
        ...state,
        marginMm: action.margin,
        scaledPaths: null,
        plan: null,
      };
    case "SET_FIT_PAGE":
      return {
        ...state,
        fitPage: action.fitPage,
        scaledPaths: null,
        plan: null,
      };
    case "SET_PEN_UP_HEIGHT":
      return {
        ...state,
        penUpHeight: action.height,
        plan: null,
      };
    case "SET_PEN_DOWN_HEIGHT":
      return {
        ...state,
        penDownHeight: action.height,
        plan: null,
      };
    case "PLOTTING_START":
      return {
        ...state,
        plotting: true,
        progress: 0,
        currentMotion: 0,
        totalMotions: action.totalMotions,
        error: null,
      };
    case "PLOTTING_PROGRESS":
      return {
        ...state,
        currentMotion: action.current,
        progress: action.current / state.totalMotions,
      };
    case "PLOTTING_COMPLETE":
      return {
        ...state,
        plotting: false,
        progress: 1,
      };
    case "PLOTTING_ERROR":
      return {
        ...state,
        plotting: false,
        error: action.error,
      };
    case "SET_ERROR":
      return {
        ...state,
        error: action.error,
      };
    case "CLEAR_ERROR":
      return {
        ...state,
        error: null,
      };
    case "UPDATE_STEPPERS_POWERED":
      return {
        ...state,
        steppersPowered: action.powered,
      };
    default:
      return state;
  }
}
