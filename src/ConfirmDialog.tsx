import { useEffect } from "react";
import { useUI } from "./ui";
import "./overlays.css";

// Single global confirm dialog, driven by useUI().requestConfirm(...).
export function ConfirmDialog() {
  const confirm = useUI((s) => s.confirm);
  const dismiss = useUI((s) => s.dismissConfirm);

  useEffect(() => {
    if (!confirm) return;
    const onKey = (e: KeyboardEvent) => {
      // Esc cancels. No Enter-to-confirm: these dialogs guard destructive actions,
      // so confirmation must be a deliberate click.
      if (e.key === "Escape") dismiss();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [confirm, dismiss]);

  if (!confirm) return null;
  const { title, body, confirmLabel, danger, onConfirm } = confirm;

  return (
    <div className="ov-scrim ov-confirm" onMouseDown={dismiss}>
      <div className="confirm-modal" onMouseDown={(e) => e.stopPropagation()} role="alertdialog" aria-label={title}>
        <div className="confirm-title">{title}</div>
        {body && <div className="confirm-body">{body}</div>}
        <div className="confirm-actions">
          <button className="btn-ghost" onClick={dismiss}>Cancel</button>
          <button className={danger ? "btn-danger" : "btn-primary"} onClick={() => { onConfirm(); dismiss(); }}>
            {confirmLabel ?? "Confirm"}
          </button>
        </div>
      </div>
    </div>
  );
}
