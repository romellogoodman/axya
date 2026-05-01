import { useState } from "react";
import { Modal } from "./Modal.jsx";
import { PLOTTER_MODELS } from "./lib/svg.js";

/** Schema for the nextdraw.conf.py form. */
const SCHEMA = [
  {
    group: "Hardware",
    fields: [
      {
        key: "model",
        label: "Plotter model",
        type: "select",
        options: Object.entries(PLOTTER_MODELS).map(([v, m]) => ({
          value: Number(v),
          label: `${v} — ${m.name}`,
        })),
      },
      {
        key: "penlift",
        label: "Pen lift servo",
        type: "select",
        options: [
          { value: 1, label: "Default for model" },
          { value: 3, label: "Brushless upgrade" },
        ],
      },
      {
        key: "resolution",
        label: "Resolution",
        type: "select",
        options: [
          { value: 1, label: "High (smoother)" },
          { value: 2, label: "Low (faster)" },
        ],
      },
    ],
  },
  {
    group: "Pen",
    fields: [
      { key: "pen_pos_up", label: "Up position (%)", type: "number", min: 0, max: 100 },
      { key: "pen_pos_down", label: "Down position (%)", type: "number", min: 0, max: 100 },
      { key: "pen_rate_raise", label: "Raise rate (%)", type: "number", min: 1, max: 100 },
      { key: "pen_rate_lower", label: "Lower rate (%)", type: "number", min: 1, max: 100 },
      { key: "pen_delay_up", label: "Delay after raise (ms)", type: "number" },
      { key: "pen_delay_down", label: "Delay after lower (ms)", type: "number" },
    ],
  },
  {
    group: "Speed",
    fields: [
      { key: "speed_pendown", label: "Drawing speed (%)", type: "number", min: 1, max: 100 },
      { key: "speed_penup", label: "Travel speed (%)", type: "number", min: 1, max: 100 },
      { key: "accel", label: "Acceleration (%)", type: "number", min: 1, max: 100 },
      { key: "const_speed", label: "Constant speed (no accel)", type: "checkbox" },
    ],
  },
  {
    group: "Path optimization",
    fields: [
      {
        key: "reordering",
        label: "Path reordering",
        type: "select",
        options: [
          { value: 0, label: "Connect adjoining only" },
          { value: 1, label: "Reorder" },
          { value: 2, label: "Reorder + allow reverse" },
          { value: 4, label: "None (preserve order)" },
        ],
      },
      { key: "random_start", label: "Randomize closed-path start", type: "checkbox" },
      { key: "hiding", label: "Hidden-line removal", type: "checkbox" },
      { key: "auto_rotate", label: "Auto-rotate to fit", type: "checkbox" },
    ],
  },
  {
    group: "Copies",
    fields: [
      { key: "copies", label: "Number of copies", type: "number", min: 1 },
      { key: "page_delay", label: "Delay between copies (s)", type: "number", min: 0 },
    ],
  },
];

export function ConfigModal({ config, onSave, onClose }) {
  const [draft, setDraft] = useState({ ...config });

  const set = (key, value) => setDraft((d) => ({ ...d, [key]: value }));

  const renderField = (f) => {
    const value = draft[f.key];
    if (f.type === "select") {
      return (
        <select
          className="select"
          value={value ?? ""}
          onChange={(e) => set(f.key, Number(e.target.value))}
        >
          {f.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      );
    }
    if (f.type === "checkbox") {
      return (
        <input
          type="checkbox"
          checked={!!value}
          onChange={(e) => set(f.key, e.target.checked)}
        />
      );
    }
    return (
      <input
        type="number"
        className="input"
        value={value ?? ""}
        min={f.min}
        max={f.max}
        onChange={(e) => set(f.key, Number(e.target.value))}
      />
    );
  };

  return (
    <Modal title="Plotter Configuration" onClose={onClose} wide>
      <div className="config-modal">
        {SCHEMA.map((section) => (
          <div key={section.group} className="config-modal__section">
            <h3 className="config-modal__group">{section.group}</h3>
            <div className="config-modal__fields">
              {section.fields.map((f) => (
                <div
                  key={f.key}
                  className={`form-group ${f.type === "checkbox" ? "form-group--checkbox" : ""}`}
                >
                  {f.type === "checkbox" ? (
                    <>
                      {renderField(f)}
                      <label>{f.label}</label>
                    </>
                  ) : (
                    <>
                      <label>{f.label}</label>
                      {renderField(f)}
                    </>
                  )}
                </div>
              ))}
            </div>
          </div>
        ))}
        <div className="config-modal__actions">
          <button className="button button--secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            className="button button--primary"
            onClick={() => onSave(draft)}
          >
            Save
          </button>
        </div>
      </div>
    </Modal>
  );
}
