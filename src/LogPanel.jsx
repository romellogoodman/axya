import { useEffect, useRef } from "react";

function ts(t) {
  const d = new Date(t);
  return d.toLocaleTimeString([], { hour12: false });
}

export function LogPanel({ logs, onClose }) {
  const scrollRef = useRef(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom =
      el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [logs]);

  return (
    <div className="log-panel">
      <div className="log-panel__header">
        <span className="log-panel__title">Log</span>
        <button className="log-panel__close" onClick={onClose}>
          ×
        </button>
      </div>
      <div className="log-panel__body" ref={scrollRef}>
        {logs.length === 0 ? (
          <div className="log-panel__line log-panel__line--muted">
            No output yet.
          </div>
        ) : (
          logs.map((entry, i) => (
            <div
              key={i}
              className={`log-panel__line log-panel__line--${entry.level}`}
            >
              <span className="log-panel__ts">{ts(entry.t)}</span>
              <span className="log-panel__text">{entry.line}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
