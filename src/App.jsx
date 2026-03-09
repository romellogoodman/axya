import { useReducer, useRef, useEffect, useCallback, useState } from "react";
import "./App.scss";

import { EBB } from "./lib/ebb.js";
import { parseSVG, scalePaths, PaperSizes, Plotters } from "./lib/svg.js";
import { createPlan, formatDuration } from "./lib/planning.js";
import { reducer, initialState, PERSISTED_KEYS, STORAGE_KEY } from "./state.js";
import { Preview } from "./Preview.jsx";

function App() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef(null);
  const abortControllerRef = useRef(null);

  // Get paper dimensions and device config
  const paper = { width: state.paperWidth, height: state.paperHeight };
  const plotter = Plotters[state.plotter];
  const device = plotter?.device;

  // Effect: Persist settings to localStorage
  useEffect(
    () => {
      const toSave = {};
      for (const key of PERSISTED_KEYS) toSave[key] = state[key];
      localStorage.setItem(STORAGE_KEY, JSON.stringify(toSave));
    },
    PERSISTED_KEYS.map((k) => state[k])
  ); // eslint-disable-line react-hooks/exhaustive-deps

  // Effect: Scale paths when paper size, margin, plotter, or fit page changes
  useEffect(() => {
    if (!state.rawPaths || !device) return;

    const scaled = scalePaths(state.rawPaths, {
      paperWidth: paper.width,
      paperHeight: paper.height,
      marginMm: state.marginMm,
      fitPage: state.fitPage,
      svgWidth: state.svgWidth,
      svgHeight: state.svgHeight,
      viewBox: state.svgViewBox,
      device,
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
    device,
  ]);

  // Effect: Create plan when scaled paths, pen heights, or plotter change
  useEffect(() => {
    if (!state.scaledPaths || state.scaledPaths.length === 0 || !device) return;

    const plan = createPlan(state.scaledPaths, {
      penUpHeight: state.penUpHeight,
      penDownHeight: state.penDownHeight,
      device,
    });

    dispatch({
      type: "SET_PLAN",
      plan,
      duration: plan.duration(),
    });
  }, [state.scaledPaths, state.penUpHeight, state.penDownHeight, device]);

  // Complete the connection handshake after obtaining an EBB instance
  const finishConnect = useCallback(async (ebb) => {
    const firmwareVersion = await ebb.firmwareVersion();
    const steppersPowered = await ebb.areSteppersPowered();
    dispatch({ type: "CONNECTED", ebb, firmwareVersion, steppersPowered });
  }, []);

  // Handler: Connect to plotter (user-initiated, shows port picker)
  const handleConnect = useCallback(async () => {
    try {
      const ebb = await EBB.connect();
      await finishConnect(ebb);
    } catch (err) {
      dispatch({ type: "SET_ERROR", error: err.message });
    }
  }, [finishConnect]);

  // Effect: Auto-reconnect to previously-paired device on mount
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const ebb = await EBB.tryAutoConnect();
        if (ebb && !cancelled) await finishConnect(ebb);
      } catch {
        // Silent — user can connect manually
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [finishConnect]);

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
    if (!file || !file.name.toLowerCase().endsWith(".svg")) {
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
  const handleFileUpload = useCallback(
    (event) => {
      const file = event.target.files?.[0];
      if (file) processFile(file);
    },
    [processFile]
  );

  // Handler: Drag and drop
  const handleDragOver = useCallback((e) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback(
    (e) => {
      e.preventDefault();
      setIsDragging(false);
      const file = e.dataTransfer.files?.[0];
      if (file) processFile(file);
    },
    [processFile]
  );

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
  // EBB.executePlan handles pen lift + HM home + motor disable on abort.
  const handleStop = useCallback(() => {
    abortControllerRef.current?.abort();
  }, []);

  // Handler: Pen up
  const handlePenUp = useCallback(async () => {
    if (!state.ebb || !device) return;
    try {
      await state.ebb.penUp(state.penUpHeight, device);
    } catch (err) {
      dispatch({ type: "SET_ERROR", error: err.message });
    }
  }, [state.ebb, state.penUpHeight, device]);

  // Handler: Pen down
  const handlePenDown = useCallback(async () => {
    if (!state.ebb || !device) return;
    try {
      await state.ebb.penDown(state.penDownHeight, device);
    } catch (err) {
      dispatch({ type: "SET_ERROR", error: err.message });
    }
  }, [state.ebb, state.penDownHeight, device]);

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
          <div className="connection-group">
            <button
              onClick={state.connected ? handleDisconnect : handleConnect}
              className={`connection-btn ${state.connected ? "connection-btn--connected" : ""}`}
            >
              <span className="connection-btn__dot"></span>
              <span>{state.connected ? "Connected" : "Not Connected"}</span>
            </button>
            <button
              onClick={handleDisableMotors}
              disabled={!state.connected}
              className="button button--secondary button--small"
              title="Disable Motors"
            >
              Off
            </button>
          </div>

          {/* File Upload Section */}
          {/* <section className="panel">
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
          </section> */}

          {/* Plotter Selection */}
          <section className="panel">
            <h2 className="panel__title">Plotter</h2>
            <div className="panel__content">
              <div className="form-group">
                {/* <label htmlFor="plotter">Model</label> */}
                <select
                  id="plotter"
                  value={state.plotter}
                  onChange={(e) => {
                    dispatch({
                      type: "SET_PLOTTER",
                      plotter: e.target.value,
                    });
                  }}
                  className="select"
                >
                  {Object.keys(Plotters).map((plotter) => (
                    <option key={plotter} value={plotter}>
                      {plotter}
                    </option>
                  ))}
                </select>
              </div>
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

              <div className="form-row">
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
                    max={Math.round((plotter?.maxWidth / 25.4) * 100) / 100}
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
                    max={Math.round((plotter?.maxHeight / 25.4) * 100) / 100}
                    step={0.1}
                    className="input"
                  />
                </div>
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

              {/* <div className="form-group form-group--checkbox">
                <input
                  type="checkbox"
                  id="fit-page"
                  checked={state.fitPage}
                  onChange={(e) =>
                    dispatch({ type: "SET_FIT_PAGE", fitPage: e.target.checked })
                  }
                />
                <label htmlFor="fit-page">Fit to page</label>
              </div> */}
            </div>
          </section>

          {/* Pen Configuration */}
          <section className="panel">
            <h2 className="panel__title">Pen Height</h2>
            <div className="panel__content">
              <div className="form-row">
                <div className="form-group">
                  <label htmlFor="pen-up">Up (%)</label>
                  <input
                    type="number"
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
                    className="input"
                  />
                </div>
                <div className="form-group">
                  <label htmlFor="pen-down">Down (%)</label>
                  <input
                    type="number"
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
                    className="input"
                  />
                </div>
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
              <button onClick={handleStop} className="button button--danger">
                Stop
              </button>
            ) : (
              <button
                onClick={handlePlot}
                disabled={!state.connected || !state.plan}
                className="button button--primary"
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
          <Preview
            paths={state.scaledPaths}
            paperWidth={paper.width}
            paperHeight={paper.height}
            marginMm={state.marginMm}
            plotting={state.plotting}
            progress={state.progress}
            isDragging={isDragging}
          />
        </div>
      </div>
    </main>
  );
}

export default App;
