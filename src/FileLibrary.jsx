import { useRef } from "react";
import { Modal } from "./Modal.jsx";

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function FileLibrary({
  files,
  selectedFile,
  onSelect,
  onUpload,
  onDelete,
  onClose,
}) {
  const fileInputRef = useRef(null);

  return (
    <Modal title="File Library" onClose={onClose} wide>
      <div className="file-library">
        <div className="file-library__toolbar">
          <button
            className="button button--primary"
            onClick={() => fileInputRef.current?.click()}
          >
            Upload SVG
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".svg"
            className="file-input"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) onUpload(f);
              e.target.value = "";
            }}
          />
        </div>

        {files.length === 0 ? (
          <p className="file-library__empty">
            No files yet. Upload an SVG or drop one on the preview.
          </p>
        ) : (
          <ul className="file-library__list">
            {files.map((f) => (
              <li
                key={f.name}
                className={`file-library__item ${
                  f.name === selectedFile ? "file-library__item--selected" : ""
                }`}
                onClick={() => onSelect(f.name)}
              >
                <div className="file-library__thumb">
                  <img
                    src={`/api/files/${encodeURIComponent(f.name)}`}
                    alt=""
                  />
                </div>
                <div className="file-library__info">
                  <div className="file-library__name">{f.name}</div>
                  <div className="file-library__meta">
                    {formatBytes(f.size)} ·{" "}
                    {new Date(f.mtime).toLocaleDateString()}
                  </div>
                </div>
                <button
                  className="file-library__delete"
                  title="Delete"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (confirm(`Delete ${f.name}?`)) onDelete(f.name);
                  }}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
}
