import { useUI, useOverlayEsc } from "./ui";
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

  // UX-542/543: this dialog is modal by nature — it can be opened FROM inside
  // another open overlay (e.g. Review's "Merge back" confirm), so it must
  // register on top of whatever's already on the stack and win the next Esc.
  // The stack is plain LIFO by push order (ui.ts), and a confirm always opens
  // strictly after whatever it was opened from, so this falls out for free —
  // no explicit priority/z-index bookkeeping needed here.
  useOverlayEsc(!!confirm, cancel);

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
