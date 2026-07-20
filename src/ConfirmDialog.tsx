import { useEffect } from "react";
import { useUI } from "./ui";
import "./overlays.css";

// Single global confirm dialog, driven by useUI().requestConfirm(...).
export function ConfirmDialog() {
  const confirm = useUI((s) => s.confirm);
  const dismiss = useUI((s) => s.dismissConfirm);

  // Every route out of the dialog that ISN'T confirming has to run onCancel:
  // a caller awaiting an answer (see trust.ts) would otherwise hang forever on
  // an Escape or a scrim click, with no visible failure.
  const cancel = () => {
    confirm?.onCancel?.();
    dismiss();
  };

  useEffect(() => {
    if (!confirm) return;
    const onKey = (e: KeyboardEvent) => {
      // Esc cancels. No Enter-to-confirm: these dialogs guard destructive actions,
      // so confirmation must be a deliberate click.
      if (e.key === "Escape") cancel();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [confirm, dismiss]);

  if (!confirm) return null;
  const { title, body, confirmLabel, danger, onConfirm } = confirm;

  return (
    <div className="ov-scrim ov-confirm" onMouseDown={cancel}>
      <div className="confirm-modal" onMouseDown={(e) => e.stopPropagation()} role="alertdialog" aria-label={title}>
        <div className="confirm-title">{title}</div>
        {body && <div className="confirm-body">{body}</div>}
        <div className="confirm-actions">
          <button className="btn-ghost" onClick={cancel}>Cancel</button>
          <button className={danger ? "btn-danger" : "btn-primary"} onClick={() => { onConfirm(); dismiss(); }}>
            {confirmLabel ?? "Confirm"}
          </button>
        </div>
      </div>
    </div>
  );
}
