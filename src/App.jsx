import { useReducer, useEffect, useCallback, useRef, useState } from "react";
import "./App.scss";

import { api, subscribeStatus } from "./lib/api.js";
import { parseSVG, PLOTTER_MODELS, PaperSizes, formatDuration } from "./lib/svg.js";
import { reducer, initialState, PERSISTED_KEYS, STORAGE_KEY } from "./state.js";

import { Preview } from "./Preview.jsx";
import { FileLibrary } from "./FileLibrary.jsx";
import { JogPad } from "./JogPad.jsx";
import { LogPanel } from "./LogPanel.jsx";
import { ConfigModal } from "./ConfigModal.jsx";

const STATE_LABELS = {
  idle: "Idle",
  plotting: "Plotting",
  paused: "Paused",
  error: "Error",
};

function App() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const [isDragging, setIsDragging] = useState(false);
  const [penUp, setPenUp] = useState(80);
  const [penDown, setPenDown] = useState(30);
  const prevStateRef = useRef(state.status.state);
  const logVersionRef = useRef(-1);

  const { status, config } = state;
  const model = PLOTTER_MODELS[config?.model] || PLOTTER_MODELS[8];
  const busy = status.state === "plotting";

  // ---- helpers ----
  const setError = useCallback(
    (err) => dispatch({ type: "SET_ERROR", error: err?.message || String(err) }),
    []
  );

  const run = useCallback(
    (fn) =>
      Promise.resolve()
        .then(fn)
        .catch(setError),
    [setError]
  );

  const refreshFiles = useCallback(
    () => run(async () => dispatch({ type: "SET_FILES", files: await api.files() })),
    [run]
  );

  const refreshConfig = useCallback(
    () => run(async () => dispatch({ type: "SET_CONFIG", config: await api.config() })),
    [run]
  );

  const refreshLogs = useCallback(
    () => run(async () => dispatch({ type: "SET_LOGS", logs: await api.logs() })),
    [run]
  );

  useEffect(() => {
    if (state.config) {
      setPenUp(state.config.pen_pos_up);
      setPenDown(state.config.pen_pos_down);
    }
  }, [state.config]);

  const handlePenPosSave = useCallback(
    (key, value) =>
      run(async () => {
        await api.saveConfig({ ...state.config, [key]: value });
        await refreshConfig();
      }),
    [run, state.config, refreshConfig]
  );

  // ---- effects: persistence ----
  useEffect(
    () => {
      const toSave = {};
      for (const key of PERSISTED_KEYS) toSave[key] = state[key];
      localStorage.setItem(STORAGE_KEY, JSON.stringify(toSave));
    },
    PERSISTED_KEYS.map((k) => state[k]) // eslint-disable-line react-hooks/exhaustive-deps
  );

  // ---- effects: SSE subscription + initial load ----
  useEffect(() => {
    refreshFiles();
    refreshConfig();
    refreshLogs();
    if ("Notification" in window && Notification.permission === "default") {
      Notification.requestPermission();
    }
    return subscribeStatus(
      (s) => dispatch({ type: "STATUS", status: s }),
      (connected) => dispatch({ type: "SERVER_CONNECTED", connected })
    );
  }, [refreshFiles, refreshConfig, refreshLogs]);

  // ---- effects: fetch selected file's SVG + layers ----
  useEffect(() => {
    if (!state.selectedFile) return;
    run(async () => {
      const [svgString, layers] = await Promise.all([
        api.file(state.selectedFile),
        api.layers(state.selectedFile),
      ]);
      const { paths, widthMm, heightMm } = parseSVG(svgString);
      dispatch({ type: "SET_SVG", svgString, paths, widthMm, heightMm });
      dispatch({ type: "SET_LAYERS", layers });
    });
  }, [state.selectedFile, run]);

  // ---- effects: refetch logs when logVersion changes ----
  useEffect(() => {
    if (status.logVersion !== logVersionRef.current) {
      logVersionRef.current = status.logVersion;
      if (state.showLog) refreshLogs();
    }
  }, [status.logVersion, state.showLog, refreshLogs]);

  // ---- effects: state-transition notifications ----
  useEffect(() => {
    const prev = prevStateRef.current;
    const cur = status.state;
    if (prev === cur) return;
    prevStateRef.current = cur;

    if (!("Notification" in window) || Notification.permission !== "granted")
      return;

    if (prev === "plotting" && cur === "idle") {
      new Notification("Plot complete", { body: status.currentFile || "" });
    } else if (cur === "paused") {
      new Notification("Plot paused", { body: status.currentFile || "" });
    } else if (cur === "error") {
      new Notification("Plot error", { body: status.error || "" });
    }
  }, [status.state, status.currentFile, status.error]);

  // ---- handlers ----
  const handleUpload = useCallback(
    (file) =>
      run(async () => {
        const { name } = await api.upload(file);
        await refreshFiles();
        dispatch({ type: "SELECT_FILE", file: name });
        dispatch({ type: "TOGGLE_FILE_LIBRARY", show: false });
      }),
    [run, refreshFiles]
  );

  const handleDeleteFile = useCallback(
    (name) =>
      run(async () => {
        await api.deleteFile(name);
        if (name === state.selectedFile) dispatch({ type: "SELECT_FILE", file: null });
        await refreshFiles();
      }),
    [run, refreshFiles, state.selectedFile]
  );

  const handleSelectFile = useCallback((name) => {
    dispatch({ type: "SELECT_FILE", file: name });
    dispatch({ type: "TOGGLE_FILE_LIBRARY", show: false });
  }, []);

  const handlePlot = useCallback(
    () => run(() => api.plot(state.selectedFile, state.selectedLayer)),
    [run, state.selectedFile, state.selectedLayer]
  );

  const handleEstimate = useCallback(
    () =>
      run(async () => {
        const est = await api.estimate(state.selectedFile, state.selectedLayer);
        dispatch({ type: "SET_ESTIMATE", estimate: est });
      }),
    [run, state.selectedFile, state.selectedLayer]
  );

  const handleSaveConfig = useCallback(
    (draft) =>
      run(async () => {
        await api.saveConfig(draft);
        await refreshConfig();
        dispatch({ type: "TOGGLE_CONFIG", show: false });
      }),
    [run, refreshConfig]
  );

  // ---- drag & drop ----
  const handleDragOver = (e) => {
    e.preventDefault();
    setIsDragging(true);
  };
  const handleDragLeave = (e) => {
    e.preventDefault();
    setIsDragging(false);
  };
  const handleDrop = (e) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file && file.name.toLowerCase().endsWith(".svg")) handleUpload(file);
  };

  // ---- derived ----
  const eta =
    status.progress > 0 && status.progress < 100
      ? (status.elapsed * (100 - status.progress)) / status.progress
      : null;

  const summaryPill = config
    ? `${model.name.split(" ").slice(-1)[0]} · ↑${config.pen_pos_up} ↓${config.pen_pos_down} · ⚡${config.speed_pendown}`
    : "";

  return (
    <main className="app">
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
          {/* Status */}
          <section className="panel">
            <h2 className="panel__title">Plotter</h2>
            <div
              className={`status-badge status-badge--${state.serverConnected ? status.state : "offline"}`}
            >
              <span className="status-badge__dot" />
              <span className="status-badge__label">
                {state.serverConnected
                  ? STATE_LABELS[status.state]
                  : "Server offline"}
              </span>
              {busy && (
                <span className="status-badge__progress">{status.progress}%</span>
              )}
            </div>
            {state.serverConnected && status.connected !== null && (
              <div className={`connection-dot connection-dot--${status.connected ? "on" : "off"}`}>
                {status.connected ? "Plotter connected" : "No plotter"}
              </div>
            )}
            {config && <div className="summary-pill">{summaryPill}</div>}
            <button
              className="button button--secondary"
              onClick={() => dispatch({ type: "TOGGLE_CONFIG", show: true })}
            >
              Configure
            </button>
          </section>

          {/* File */}
          <section className="panel">
            <h2 className="panel__title">File</h2>
            <button
              className="file-select"
              onClick={() => dispatch({ type: "TOGGLE_FILE_LIBRARY", show: true })}
            >
              <span className="file-select__name">
                {state.selectedFile || "Choose a file…"}
              </span>
              <span className="file-select__arrow">›</span>
            </button>
          </section>

          {/* Paper */}
          <section className="panel">
            <h2 className="panel__title">Paper</h2>
            <div className="form-row">
              <div className="form-group">
                <label>Size</label>
                <select
                  className="select"
                  value={state.paperSize}
                  onChange={(e) => dispatch({ type: "SET_PAPER_SIZE", size: e.target.value })}
                >
                  {Object.keys(PaperSizes).map((name) => (
                    <option key={name} value={name}>{name}</option>
                  ))}
                  <option value="Custom">Custom</option>
                </select>
              </div>
              <div className="form-group">
                <label>Margin (in)</label>
                <input
                  type="number"
                  className="input"
                  value={parseFloat((state.marginMm / 25.4).toFixed(3))}
                  min={0}
                  step={0.25}
                  onChange={(e) =>
                    dispatch({ type: "SET_MARGIN", value: Number(e.target.value) * 25.4 })
                  }
                />
              </div>
            </div>
            <div className="form-row">
              <div className="form-group">
                <label>W (in)</label>
                <input
                  type="number"
                  className="input"
                  value={parseFloat((state.paperWidthMm / 25.4).toFixed(3))}
                  min={0.1}
                  step={0.5}
                  onChange={(e) =>
                    dispatch({ type: "SET_PAPER_WIDTH", value: Number(e.target.value) * 25.4 })
                  }
                />
              </div>
              <div className="form-group">
                <label>H (in)</label>
                <input
                  type="number"
                  className="input"
                  value={parseFloat((state.paperHeightMm / 25.4).toFixed(3))}
                  min={0.1}
                  step={0.5}
                  onChange={(e) =>
                    dispatch({ type: "SET_PAPER_HEIGHT", value: Number(e.target.value) * 25.4 })
                  }
                />
              </div>
            </div>
          </section>

          {/* Layers */}
          {state.layers.length > 0 && (
            <section className="panel">
              <h2 className="panel__title">Layers</h2>
              <div className="layer-chips">
                <button
                  className={`layer-chips__chip ${state.selectedLayer == null ? "layer-chips__chip--active" : ""}`}
                  onClick={() => dispatch({ type: "SELECT_LAYER", layer: null })}
                >
                  All
                </button>
                {state.layers
                  .filter((l) => l.number != null)
                  .map((l) => (
                    <button
                      key={l.label}
                      className={`layer-chips__chip ${state.selectedLayer === l.number ? "layer-chips__chip--active" : ""}`}
                      onClick={() =>
                        dispatch({ type: "SELECT_LAYER", layer: l.number })
                      }
                      title={l.label}
                    >
                      {l.label}
                    </button>
                  ))}
              </div>
            </section>
          )}

          {/* Estimate */}
          <section className="panel">
            <h2 className="panel__title">Estimate</h2>
            <button
              className="button button--secondary"
              onClick={handleEstimate}
              disabled={!state.selectedFile || busy}
            >
              Calculate
            </button>
            {state.estimate && (
              <div className="estimate">
                {state.estimate.time && (
                  <div className="estimate__row">
                    <span>Time</span>
                    <strong>{state.estimate.time}</strong>
                  </div>
                )}
                {state.estimate.drawDistance && (
                  <div className="estimate__row">
                    <span>Draw</span>
                    <strong>{state.estimate.drawDistance}</strong>
                  </div>
                )}
                {state.estimate.travelDistance && (
                  <div className="estimate__row">
                    <span>Travel</span>
                    <strong>{state.estimate.travelDistance}</strong>
                  </div>
                )}
              </div>
            )}
          </section>

          {/* Manual */}
          <section className="panel">
            <h2 className="panel__title">Manual</h2>
            {state.config && (
              <div className="form-row">
                <div className="form-group">
                  <label>Up %</label>
                  <input
                    type="number"
                    className="input"
                    value={penUp}
                    min={0}
                    max={100}
                    onChange={(e) => setPenUp(Number(e.target.value))}
                    onBlur={(e) => handlePenPosSave("pen_pos_up", Number(e.target.value))}
                  />
                </div>
                <div className="form-group">
                  <label>Down %</label>
                  <input
                    type="number"
                    className="input"
                    value={penDown}
                    min={0}
                    max={100}
                    onChange={(e) => setPenDown(Number(e.target.value))}
                    onBlur={(e) => handlePenPosSave("pen_pos_down", Number(e.target.value))}
                  />
                </div>
              </div>
            )}
            <div className="button-group">
              <button
                className="button button--secondary"
                onClick={() => run(() => api.pen("up"))}
                disabled={busy}
              >
                Pen Up
              </button>
              <button
                className="button button--secondary"
                onClick={() => run(() => api.pen("down"))}
                disabled={busy}
              >
                Pen Down
              </button>
            </div>
            <button
              className="button button--secondary"
              onClick={() => dispatch({ type: "TOGGLE_JOG", show: true })}
              disabled={busy}
            >
              Jog / Home
            </button>
            <button
              className="button button--secondary"
              onClick={() => {
                dispatch({ type: "TOGGLE_LOG", show: !state.showLog });
                if (!state.showLog) refreshLogs();
              }}
            >
              {state.showLog ? "Hide Log" : "Show Log"}
            </button>
          </section>

          {/* Plot Controls */}
          <div className="plot-controls">
            {busy && (
              <div className="stats-bar">
                <span className="stats-bar__item">
                  {formatDuration(status.elapsed)} elapsed
                </span>
                {eta != null && (
                  <span className="stats-bar__item">
                    {formatDuration(eta)} left
                  </span>
                )}
              </div>
            )}

            {status.state === "plotting" && (
              <div className="button-group">
                <button
                  className="button button--secondary"
                  onClick={() => run(api.pause)}
                >
                  Pause
                </button>
                <button
                  className="button button--danger"
                  onClick={() => run(api.stop)}
                >
                  Stop
                </button>
              </div>
            )}

            {status.state === "paused" && (
              <>
                <button
                  className="button button--primary"
                  onClick={() => run(api.resume)}
                >
                  Resume
                </button>
                <div className="button-group">
                  <button
                    className="button button--secondary"
                    onClick={() => run(api.home)}
                  >
                    Home
                  </button>
                  <button
                    className="button button--danger"
                    onClick={() => run(api.stop)}
                  >
                    Cancel
                  </button>
                </div>
              </>
            )}

            {(status.state === "idle" || status.state === "error") && (
              <button
                className="button button--primary"
                onClick={handlePlot}
                disabled={!state.selectedFile || !state.serverConnected}
              >
                {!state.selectedFile
                  ? "Select a file to plot"
                  : state.selectedLayer != null
                    ? `Plot layer ${state.selectedLayer}`
                    : "Plot"}
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
            paths={state.paths}
            svgWidthMm={state.svgWidthMm}
            svgHeightMm={state.svgHeightMm}
            travelWidthMm={model.width}
            travelHeightMm={model.height}
            paperWidthMm={state.paperWidthMm}
            paperHeightMm={state.paperHeightMm}
            marginMm={state.marginMm}
            progress={status.progress}
            isDragging={isDragging}
            onUploadClick={() =>
              dispatch({ type: "TOGGLE_FILE_LIBRARY", show: true })
            }
          />
          {state.showLog && (
            <LogPanel
              logs={state.logs}
              onClose={() => dispatch({ type: "TOGGLE_LOG", show: false })}
            />
          )}
        </div>
      </div>

      {/* Modals */}
      {state.showFileLibrary && (
        <FileLibrary
          files={state.files}
          selectedFile={state.selectedFile}
          onSelect={handleSelectFile}
          onUpload={handleUpload}
          onDelete={handleDeleteFile}
          onClose={() => dispatch({ type: "TOGGLE_FILE_LIBRARY", show: false })}
        />
      )}
      {state.showConfig && config && (
        <ConfigModal
          config={config}
          onSave={handleSaveConfig}
          onClose={() => dispatch({ type: "TOGGLE_CONFIG", show: false })}
        />
      )}
      {state.showJog && (
        <JogPad
          busy={busy}
          canHome={status.canHome}
          onJog={(dx, dy) => run(() => api.jog(dx, dy))}
          onPen={(dir) => run(() => api.pen(dir))}
          onHome={() => run(api.home)}
          onClose={() => dispatch({ type: "TOGGLE_JOG", show: false })}
        />
      )}
    </main>
  );
}

export default App;
