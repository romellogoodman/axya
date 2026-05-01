import { useState } from "react";
import { Modal } from "./Modal.jsx";

export function JogPad({ onJog, onPen, onHome, canHome, busy, onClose }) {
  const [step, setStep] = useState(10);

  const btn = (label, dx, dy) => (
    <button
      className="jog-pad__btn"
      disabled={busy}
      onClick={() => onJog(dx * step, dy * step)}
    >
      {label}
    </button>
  );

  return (
    <Modal title="Manual Control" onClose={onClose}>
      <div className="jog-pad">
        <div className="jog-pad__grid">
          <div />
          {btn("↑", 0, -1)}
          <div />
          {btn("←", -1, 0)}
          <button
            className="jog-pad__btn jog-pad__btn--home"
            disabled={busy || !canHome}
            onClick={onHome}
            title={canHome ? "Return to home" : "Home available after pause/stop"}
          >
            ⌂
          </button>
          {btn("→", 1, 0)}
          <div />
          {btn("↓", 0, 1)}
          <div />
        </div>

        <div className="form-group">
          <label htmlFor="jog-step">Step (mm)</label>
          <input
            id="jog-step"
            type="number"
            className="input"
            value={step}
            min={0.1}
            step={0.1}
            onChange={(e) => setStep(Number(e.target.value))}
          />
        </div>

        <div className="button-group">
          <button
            className="button button--secondary"
            disabled={busy}
            onClick={() => onPen("up")}
          >
            Pen Up
          </button>
          <button
            className="button button--secondary"
            disabled={busy}
            onClick={() => onPen("down")}
          >
            Pen Down
          </button>
        </div>
      </div>
    </Modal>
  );
}
