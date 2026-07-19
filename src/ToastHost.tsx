import { useEffect } from "react";
import { useUI } from "./ui";
import "./overlays.css";

function ToastItem({ id, kind, text }: { id: number; kind: string; text: string }) {
  const dismiss = useUI((s) => s.dismissToast);
  useEffect(() => {
    const t = window.setTimeout(() => dismiss(id), 3500);
    return () => window.clearTimeout(t);
  }, [id, dismiss]);
  return (
    <div className={"toast toast-" + kind} onClick={() => dismiss(id)}>
      <span className="toast-dot" />
      <span className="toast-text">{text}</span>
    </div>
  );
}

export function ToastHost() {
  const toasts = useUI((s) => s.toasts);
  if (toasts.length === 0) return null;
  return (
    <div className="toast-host">
      {toasts.map((t) => <ToastItem key={t.id} {...t} />)}
    </div>
  );
}
