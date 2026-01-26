import { useReducer, useRef, useEffect, useCallback, useState } from "react";
import "./App.scss";

import { EBB } from "./lib/ebb.js";
import { parseSVG, scalePaths, PaperSizes } from "./lib/svg.js";
import { createPlan, formatDuration, Device } from "./lib/planning.js";

// Initial state for the reducer
const initialState = {
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
};

// Reducer for state management
function reducer(state, action) {
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

function App() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const canvasRef = useRef(null);
  const previewRef = useRef(null);
  const fileInputRef = useRef(null);
  const abortControllerRef = useRef(null);

  // Get paper dimensions
  const paper = { width: state.paperWidth, height: state.paperHeight };

  // Effect: Resize observer for canvas container
  useEffect(() => {
    const container = previewRef.current;
    if (!container) return;

    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        setCanvasSize({ width, height });
      }
    });

    resizeObserver.observe(container);
    return () => resizeObserver.disconnect();
  }, []);

  // Effect: Scale paths when paper size, margin, or fit page changes
  useEffect(() => {
    if (!state.rawPaths) return;

    const scaled = scalePaths(state.rawPaths, {
      paperWidth: paper.width,
      paperHeight: paper.height,
      marginMm: state.marginMm,
      fitPage: state.fitPage,
      svgWidth: state.svgWidth,
      svgHeight: state.svgHeight,
      viewBox: state.svgViewBox,
    });

    dispatch({ type: "SET_SCALED_PATHS", paths: scaled });
  }, [
    state.rawPaths,
    state.paperSize,
    state.marginMm,
    state.fitPage,
    state.svgWidth,
    state.svgHeight,
    state.svgViewBox,
    paper.width,
    paper.height,
  ]);

  // Effect: Create plan when scaled paths or pen heights change
  useEffect(() => {
    if (!state.scaledPaths || state.scaledPaths.length === 0) return;

    const plan = createPlan(state.scaledPaths, {
      penUpHeight: state.penUpHeight,
      penDownHeight: state.penDownHeight,
    });

    dispatch({
      type: "SET_PLAN",
      plan,
      duration: plan.duration(),
    });
  }, [state.scaledPaths, state.penUpHeight, state.penDownHeight]);

  // Effect: Draw preview on canvas
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || canvasSize.width === 0 || canvasSize.height === 0) return;

    const ctx = canvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;

    const containerWidth = canvasSize.width;
    const containerHeight = canvasSize.height;

    // Set canvas size with DPR for sharp rendering
    canvas.width = containerWidth * dpr;
    canvas.height = containerHeight * dpr;
    canvas.style.width = `${containerWidth}px`;
    canvas.style.height = `${containerHeight}px`;

    ctx.scale(dpr, dpr);

    // Clear canvas
    ctx.fillStyle = "#f8f8f7";
    ctx.fillRect(0, 0, containerWidth, containerHeight);

    // Calculate scale to fit paper in canvas
    const paperWidthSteps = paper.width * Device.stepsPerMm;
    const paperHeightSteps = paper.height * Device.stepsPerMm;

    const padding = 24;
    const availWidth = containerWidth - padding * 2;
    const availHeight = containerHeight - padding * 2;

    const scale = Math.min(
      availWidth / paperWidthSteps,
      availHeight / paperHeightSteps
    );

    const offsetX =
      padding + (availWidth - paperWidthSteps * scale) / 2;
    const offsetY =
      padding + (availHeight - paperHeightSteps * scale) / 2;

    // Draw paper
    ctx.fillStyle = "#ffffff";
    ctx.strokeStyle = "#e8e8e6";
    ctx.lineWidth = 1;
    ctx.fillRect(
      offsetX,
      offsetY,
      paperWidthSteps * scale,
      paperHeightSteps * scale
    );
    ctx.strokeRect(
      offsetX,
      offsetY,
      paperWidthSteps * scale,
      paperHeightSteps * scale
    );

    // Draw margin area
    const marginSteps = state.marginMm * Device.stepsPerMm;
    ctx.strokeStyle = "#e0e0e0";
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.strokeRect(
      offsetX + marginSteps * scale,
      offsetY + marginSteps * scale,
      (paperWidthSteps - marginSteps * 2) * scale,
      (paperHeightSteps - marginSteps * 2) * scale
    );
    ctx.setLineDash([]);

    // Draw paths
    if (state.scaledPaths && state.scaledPaths.length > 0) {
      ctx.strokeStyle = "#5c6bc0";
      ctx.lineWidth = 1.5;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";

      for (const path of state.scaledPaths) {
        if (path.length < 2) continue;

        ctx.beginPath();
        ctx.moveTo(
          offsetX + path[0].x * scale,
          offsetY + path[0].y * scale
        );

        for (let i = 1; i < path.length; i++) {
          ctx.lineTo(
            offsetX + path[i].x * scale,
            offsetY + path[i].y * scale
          );
        }

        ctx.stroke();
      }
    }

    // Draw progress indicator during plotting
    if (state.plotting && state.plan) {
      ctx.strokeStyle = "#81c784";
      ctx.lineWidth = 2;

      // Calculate how many paths are complete
      const completedPaths = Math.floor(
        state.progress * state.scaledPaths.length
      );

      for (let p = 0; p < completedPaths && p < state.scaledPaths.length; p++) {
        const path = state.scaledPaths[p];
        if (path.length < 2) continue;

        ctx.beginPath();
        ctx.moveTo(
          offsetX + path[0].x * scale,
          offsetY + path[0].y * scale
        );

        for (let i = 1; i < path.length; i++) {
          ctx.lineTo(
            offsetX + path[i].x * scale,
            offsetY + path[i].y * scale
          );
        }

        ctx.stroke();
      }
    }
  }, [
    state.scaledPaths,
    state.paperSize,
    state.marginMm,
    state.plotting,
    state.progress,
    state.plan,
    paper.width,
    paper.height,
    canvasSize,
  ]);

  // Handler: Connect to plotter
  const handleConnect = useCallback(async () => {
    try {
      const ebb = await EBB.connect();
      const firmwareVersion = await ebb.firmwareVersion();
      const steppersPowered = await ebb.areSteppersPowered();

      dispatch({
        type: "CONNECTED",
        ebb,
        firmwareVersion,
        steppersPowered,
      });
    } catch (err) {
      dispatch({ type: "SET_ERROR", error: err.message });
    }
  }, []);

  // Handler: Disconnect from plotter
  const handleDisconnect = useCallback(async () => {
    if (state.ebb) {
      try {
        await state.ebb.close();
      } catch (err) {
        console.error("Error closing connection:", err);
      }
    }
    dispatch({ type: "DISCONNECTED" });
  }, [state.ebb]);

  // Handler: Process SVG file
  const processFile = useCallback((file) => {
    if (!file || !file.name.toLowerCase().endsWith('.svg')) {
      dispatch({ type: "SET_ERROR", error: "Please upload an SVG file" });
      return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const svgString = e.target.result;
        const { paths, width, height, viewBox } = parseSVG(svgString);

        dispatch({
          type: "SET_SVG",
          svgString,
          fileName: file.name,
          paths,
          width,
          height,
          viewBox,
        });
      } catch (err) {
        dispatch({ type: "SET_ERROR", error: err.message });
      }
    };
    reader.readAsText(file);
  }, []);

  // Handler: File upload
  const handleFileUpload = useCallback((event) => {
    const file = event.target.files?.[0];
    if (file) processFile(file);
  }, [processFile]);

  // Handler: Drag and drop
  const handleDragOver = useCallback((e) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) processFile(file);
  }, [processFile]);

  // Handler: Start plotting
  const handlePlot = useCallback(async () => {
    if (!state.ebb || !state.plan) return;

    abortControllerRef.current = new AbortController();

    dispatch({
      type: "PLOTTING_START",
      totalMotions: state.plan.motions.length,
    });

    try {
      await state.ebb.executePlan(state.plan, {
        onProgress: (current) => {
          dispatch({ type: "PLOTTING_PROGRESS", current });
        },
        signal: abortControllerRef.current.signal,
      });

      dispatch({ type: "PLOTTING_COMPLETE" });
    } catch (err) {
      if (err.message !== "Plot aborted") {
        dispatch({ type: "PLOTTING_ERROR", error: err.message });
      } else {
        dispatch({ type: "PLOTTING_COMPLETE" });
      }
    }
  }, [state.ebb, state.plan]);

  // Handler: Stop plotting
  const handleStop = useCallback(async () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }

    // Lift pen and disable motors
    if (state.ebb) {
      try {
        await state.ebb.penUp(state.penUpHeight);
        await state.ebb.disableMotors();
      } catch (err) {
        console.error("Error stopping:", err);
      }
    }
  }, [state.ebb, state.penUpHeight]);

  // Handler: Pen up
  const handlePenUp = useCallback(async () => {
    if (!state.ebb) return;
    try {
      await state.ebb.penUp(state.penUpHeight);
    } catch (err) {
      dispatch({ type: "SET_ERROR", error: err.message });
    }
  }, [state.ebb, state.penUpHeight]);

  // Handler: Pen down
  const handlePenDown = useCallback(async () => {
    if (!state.ebb) return;
    try {
      await state.ebb.penDown(state.penDownHeight);
    } catch (err) {
      dispatch({ type: "SET_ERROR", error: err.message });
    }
  }, [state.ebb, state.penDownHeight]);

  // Handler: Disable motors
  const handleDisableMotors = useCallback(async () => {
    if (!state.ebb) return;
    try {
      await state.ebb.disableMotors();
    } catch (err) {
      dispatch({ type: "SET_ERROR", error: err.message });
    }
  }, [state.ebb]);

  return (
    <main className="app">
      {/* Error Banner */}
      {state.error && (
        <div className="app__error">
          <span>{state.error}</span>
          <button
            onClick={() => dispatch({ type: "CLEAR_ERROR" })}
            className="app__error-close"
          >
            ×
          </button>
        </div>
      )}

      <div className="app__content">
        {/* Sidebar */}
        <aside className="app__sidebar">
          {/* Connection */}
          <button
            onClick={state.connected ? handleDisconnect : handleConnect}
            className={`connection-btn ${state.connected ? "connection-btn--connected" : ""}`}
          >
            <span className="connection-btn__dot"></span>
            <span>{state.connected ? "Connected" : "Not Connected"}</span>
          </button>

          {/* File Upload Section */}
          <section className="panel">
            <h2 className="panel__title">File</h2>
            <div className="panel__content">
              <input
                type="file"
                accept=".svg"
                onChange={handleFileUpload}
                ref={fileInputRef}
                className="file-input"
                id="svg-upload"
              />
              <label htmlFor="svg-upload" className="button button--secondary">
                Upload SVG
              </label>
              {state.svgFileName && (
                <p className="panel__info">{state.svgFileName}</p>
              )}
            </div>
          </section>

          {/* Paper Configuration */}
          <section className="panel">
            <h2 className="panel__title">Paper</h2>
            <div className="panel__content">
              <div className="form-group">
                <label htmlFor="paper-size">Size</label>
                <select
                  id="paper-size"
                  value={state.paperSize}
                  onChange={(e) => {
                    const size = PaperSizes[e.target.value];
                    if (size) {
                      dispatch({
                        type: "SET_PAPER_SIZE",
                        paperSize: e.target.value,
                        width: size.width,
                        height: size.height,
                      });
                    }
                  }}
                  className="select"
                >
                  <option value="">Custom</option>
                  {Object.keys(PaperSizes).map((size) => (
                    <option key={size} value={size}>
                      {size}
                    </option>
                  ))}
                </select>
              </div>

              <div className="form-group">
                <label htmlFor="paper-width">Width (in)</label>
                <input
                  type="number"
                  id="paper-width"
                  value={Math.round((state.paperWidth / 25.4) * 100) / 100}
                  onChange={(e) =>
                    dispatch({
                      type: "SET_PAPER_WIDTH",
                      width: Number(e.target.value) * 25.4,
                    })
                  }
                  min={0.1}
                  step={0.1}
                  className="input"
                />
              </div>
              <div className="form-group">
                <label htmlFor="paper-height">Height (in)</label>
                <input
                  type="number"
                  id="paper-height"
                  value={Math.round((state.paperHeight / 25.4) * 100) / 100}
                  onChange={(e) =>
                    dispatch({
                      type: "SET_PAPER_HEIGHT",
                      height: Number(e.target.value) * 25.4,
                    })
                  }
                  min={0.1}
                  step={0.1}
                  className="input"
                />
              </div>

              <div className="form-group">
                <label htmlFor="margin">Margin (in)</label>
                <input
                  type="number"
                  id="margin"
                  value={Math.round((state.marginMm / 25.4) * 100) / 100}
                  onChange={(e) =>
                    dispatch({
                      type: "SET_MARGIN",
                      margin: Number(e.target.value) * 25.4,
                    })
                  }
                  min={0}
                  max={2}
                  step={0.1}
                  className="input"
                />
              </div>

              <div className="form-group form-group--checkbox">
                <input
                  type="checkbox"
                  id="fit-page"
                  checked={state.fitPage}
                  onChange={(e) =>
                    dispatch({ type: "SET_FIT_PAGE", fitPage: e.target.checked })
                  }
                />
                <label htmlFor="fit-page">Fit to page</label>
              </div>
            </div>
          </section>

          {/* Pen Configuration */}
          <section className="panel">
            <h2 className="panel__title">Pen Height</h2>
            <div className="panel__content">
              <div className="form-group">
                <label htmlFor="pen-up">Up Position: {state.penUpHeight}%</label>
                <input
                  type="range"
                  id="pen-up"
                  value={state.penUpHeight}
                  onChange={(e) =>
                    dispatch({
                      type: "SET_PEN_UP_HEIGHT",
                      height: Number(e.target.value),
                    })
                  }
                  min={0}
                  max={100}
                  className="range"
                />
              </div>

              <div className="form-group">
                <label htmlFor="pen-down">
                  Down Position: {state.penDownHeight}%
                </label>
                <input
                  type="range"
                  id="pen-down"
                  value={state.penDownHeight}
                  onChange={(e) =>
                    dispatch({
                      type: "SET_PEN_DOWN_HEIGHT",
                      height: Number(e.target.value),
                    })
                  }
                  min={0}
                  max={100}
                  className="range"
                />
              </div>

              <div className="button-group">
                <button
                  onClick={handlePenUp}
                  disabled={!state.connected}
                  className="button button--secondary button--small"
                >
                  Pen Up
                </button>
                <button
                  onClick={handlePenDown}
                  disabled={!state.connected}
                  className="button button--secondary button--small"
                >
                  Pen Down
                </button>
              </div>
            </div>
          </section>

          {/* Motor Control */}
          <section className="panel">
            <h2 className="panel__title">Motors</h2>
            <div className="panel__content">
              <button
                onClick={handleDisableMotors}
                disabled={!state.connected}
                className="button button--secondary"
              >
                Disable Motors
              </button>
            </div>
          </section>

          {/* Stats */}
          {(state.rawPaths || state.estimatedDuration != null) && (
            <div className="stats-bar">
              {state.rawPaths && (
                <span className="stats-bar__item">
                  {state.rawPaths.length} paths
                </span>
              )}
              {state.estimatedDuration != null && (
                <span className="stats-bar__item">
                  {formatDuration(state.estimatedDuration)}
                </span>
              )}
              {state.plotting && (
                <span className="stats-bar__item">
                  {Math.round(state.progress * 100)}%
                </span>
              )}
            </div>
          )}

          {/* Plot Controls */}
          <div className="plot-controls">
            {state.plotting ? (
              <button onClick={handleStop} className="button button--danger button--large">
                Stop
              </button>
            ) : (
              <button
                onClick={handlePlot}
                disabled={!state.connected || !state.plan}
                className="button button--primary button--large"
              >
                Plot
              </button>
            )}
          </div>
        </aside>

        {/* Main Preview Area */}
        <div
          className="app__main"
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          <div className={`preview ${isDragging ? "preview--dragging" : ""}`} ref={previewRef}>
            <canvas ref={canvasRef} className="preview__canvas" />
            {isDragging && (
              <div className="preview__drop-overlay">
                Drop SVG here
              </div>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}

export default App;
