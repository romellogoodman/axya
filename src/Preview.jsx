/**
 * Canvas preview: plotter travel area, SVG document outline, paths.
 * All coordinates in mm. Owns its own resize observer and DPR scaling.
 */

import { useEffect, useRef, useState } from "react";

function strokePath(ctx, path, ox, oy, s) {
  ctx.beginPath();
  ctx.moveTo(ox + path[0].x * s, oy + path[0].y * s);
  for (let i = 1; i < path.length; i++) {
    ctx.lineTo(ox + path[i].x * s, oy + path[i].y * s);
  }
  ctx.stroke();
}

export function Preview({
  paths,
  svgWidthMm,
  svgHeightMm,
  travelWidthMm,
  travelHeightMm,
  paperWidthMm,
  paperHeightMm,
  marginMm = 0,
  progress,
  isDragging,
  onUploadClick,
}) {
  const isEmpty = !paths || paths.length === 0;
  const containerRef = useRef(null);
  const canvasRef = useRef(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        setSize({ width, height });
      }
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || size.width === 0 || size.height === 0) return;

    const ctx = canvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    const { width: cw, height: ch } = size;

    canvas.width = cw * dpr;
    canvas.height = ch * dpr;
    canvas.style.width = `${cw}px`;
    canvas.style.height = `${ch}px`;
    ctx.scale(dpr, dpr);

    ctx.fillStyle = "#f8f8f7";
    ctx.fillRect(0, 0, cw, ch);

    const areaW = Math.max(travelWidthMm, svgWidthMm || 0, paperWidthMm || 0, 1);
    const areaH = Math.max(travelHeightMm, svgHeightMm || 0, paperHeightMm || 0, 1);

    const pad = 24;
    const availW = cw - pad * 2;
    const availH = ch - pad * 2;
    const scale = Math.min(availW / areaW, availH / areaH);
    const ox = pad + (availW - areaW * scale) / 2;
    const oy = pad + (availH - areaH * scale) / 2;

    // Travel area outline
    ctx.strokeStyle = "#d8d8d6";
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.strokeRect(ox, oy, travelWidthMm * scale, travelHeightMm * scale);
    ctx.setLineDash([]);

    // Paper rectangle (if set)
    if (paperWidthMm > 0 && paperHeightMm > 0) {
      ctx.fillStyle = "#ffffff";
      ctx.strokeStyle = "#d8d8d6";
      ctx.lineWidth = 1;
      ctx.setLineDash([]);
      ctx.fillRect(ox, oy, paperWidthMm * scale, paperHeightMm * scale);
      ctx.strokeRect(ox, oy, paperWidthMm * scale, paperHeightMm * scale);

      // Margin guide
      const mw = paperWidthMm - 2 * marginMm;
      const mh = paperHeightMm - 2 * marginMm;
      if (marginMm > 0 && mw > 0 && mh > 0) {
        ctx.strokeStyle = "#c8c8c6";
        ctx.lineWidth = 1;
        ctx.setLineDash([1, 4]);
        ctx.strokeRect(ox + marginMm * scale, oy + marginMm * scale, mw * scale, mh * scale);
        ctx.setLineDash([]);
      }
    } else if (svgWidthMm > 0 && svgHeightMm > 0) {
      ctx.fillStyle = "#ffffff";
      ctx.strokeStyle = "#e8e8e6";
      ctx.fillRect(ox, oy, svgWidthMm * scale, svgHeightMm * scale);
      ctx.strokeRect(ox, oy, svgWidthMm * scale, svgHeightMm * scale);
    }

    // Paths — scaled to fit paper with margin when both are known
    if (paths && paths.length > 0) {
      let pathOx = ox;
      let pathOy = oy;
      let pathS = scale;

      if (paperWidthMm > 0 && paperHeightMm > 0 && svgWidthMm > 0 && svgHeightMm > 0) {
        const drawW = Math.max(paperWidthMm - 2 * marginMm, 1);
        const drawH = Math.max(paperHeightMm - 2 * marginMm, 1);
        const fitScale = Math.min(drawW / svgWidthMm, drawH / svgHeightMm);
        const offX = marginMm + (drawW - svgWidthMm * fitScale) / 2;
        const offY = marginMm + (drawH - svgHeightMm * fitScale) / 2;
        pathOx = ox + offX * scale;
        pathOy = oy + offY * scale;
        pathS = scale * fitScale;
      }

      ctx.strokeStyle = "#2d2d2d";
      ctx.lineWidth = 1.25;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      for (const path of paths) {
        if (path.length >= 2) strokePath(ctx, path, pathOx, pathOy, pathS);
      }
    }
  }, [paths, svgWidthMm, svgHeightMm, travelWidthMm, travelHeightMm, paperWidthMm, paperHeightMm, marginMm, size]);

  return (
    <div
      className={`preview ${isDragging ? "preview--dragging" : ""}`}
      ref={containerRef}
    >
      <canvas ref={canvasRef} className="preview__canvas" />
      {progress > 0 && progress < 100 && (
        <div className="preview__progress">
          <div
            className="preview__progress-bar"
            style={{ width: `${progress}%` }}
          />
        </div>
      )}
      {isEmpty && !isDragging && (
        <div className="preview__empty">
          <div className="preview__empty-icon">
            <svg
              width="48"
              height="48"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
              <line x1="12" y1="12" x2="12" y2="18" />
              <line x1="9" y1="15" x2="15" y2="15" />
            </svg>
          </div>
          <p className="preview__empty-text">Drag & drop an SVG file here</p>
          <button className="button button--secondary" onClick={onUploadClick}>
            or choose from library
          </button>
        </div>
      )}
      {isDragging && <div className="preview__drop-overlay">Drop SVG here</div>}
    </div>
  );
}
