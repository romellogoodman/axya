/**
 * Canvas preview: paper outline, margin guide, paths, live progress overlay.
 * Owns its own resize observer and DPR-aware canvas sizing.
 */

import { useEffect, useRef, useState } from "react";
import { Device } from "./lib/planning.js";

function strokePath(ctx, path, offsetX, offsetY, scale) {
  ctx.beginPath();
  ctx.moveTo(offsetX + path[0].x * scale, offsetY + path[0].y * scale);
  for (let i = 1; i < path.length; i++) {
    ctx.lineTo(offsetX + path[i].x * scale, offsetY + path[i].y * scale);
  }
  ctx.stroke();
}

export function Preview({
  paths,
  paperWidth,
  paperHeight,
  marginMm,
  plotting,
  progress,
  isDragging,
}) {
  const containerRef = useRef(null);
  const canvasRef = useRef(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  // Resize observer
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

  // Draw
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

    // Background
    ctx.fillStyle = "#f8f8f7";
    ctx.fillRect(0, 0, cw, ch);

    // Fit paper in canvas
    const paperW = paperWidth * Device.stepsPerMm;
    const paperH = paperHeight * Device.stepsPerMm;
    const padding = 24;
    const availW = cw - padding * 2;
    const availH = ch - padding * 2;
    const scale = Math.min(availW / paperW, availH / paperH);
    const offsetX = padding + (availW - paperW * scale) / 2;
    const offsetY = padding + (availH - paperH * scale) / 2;

    // Paper
    ctx.fillStyle = "#ffffff";
    ctx.strokeStyle = "#e8e8e6";
    ctx.lineWidth = 1;
    ctx.fillRect(offsetX, offsetY, paperW * scale, paperH * scale);
    ctx.strokeRect(offsetX, offsetY, paperW * scale, paperH * scale);

    // Margin guide
    const marginSteps = marginMm * Device.stepsPerMm;
    ctx.strokeStyle = "#e0e0e0";
    ctx.setLineDash([3, 3]);
    ctx.strokeRect(
      offsetX + marginSteps * scale,
      offsetY + marginSteps * scale,
      (paperW - marginSteps * 2) * scale,
      (paperH - marginSteps * 2) * scale
    );
    ctx.setLineDash([]);

    // Paths
    if (paths && paths.length > 0) {
      ctx.strokeStyle = "#5c6bc0";
      ctx.lineWidth = 1.5;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      for (const path of paths) {
        if (path.length >= 2) strokePath(ctx, path, offsetX, offsetY, scale);
      }

      // Progress overlay: re-stroke completed paths in green
      if (plotting) {
        ctx.strokeStyle = "#81c784";
        ctx.lineWidth = 2;
        const completed = Math.floor(progress * paths.length);
        for (let p = 0; p < completed && p < paths.length; p++) {
          const path = paths[p];
          if (path.length >= 2) strokePath(ctx, path, offsetX, offsetY, scale);
        }
      }
    }
  }, [paths, paperWidth, paperHeight, marginMm, plotting, progress, size]);

  return (
    <div
      className={`preview ${isDragging ? "preview--dragging" : ""}`}
      ref={containerRef}
    >
      <canvas ref={canvasRef} className="preview__canvas" />
      {isDragging && (
        <div className="preview__drop-overlay">Drop SVG here</div>
      )}
    </div>
  );
}
