import { useEffect, useRef, useState } from "react";
import { useUI } from "./ui";
import "./overlays.css";

function ToastItem({ id, kind, text }: { id: number; kind: string; text: string }) {
  const dismiss = useUI((s) => s.dismissToast);
  // Pause-on-hover (UI-18): an error toast shouldn't vanish mid-read. While
  // hovered no timer runs; after mouse-leave a shorter one finishes the job.
  const [hovered, setHovered] = useState(false);
  const wasHovered = useRef(false);
  useEffect(() => {
    if (hovered) {
      wasHovered.current = true;
      return; // paused — no timer while the pointer is on the toast
    }
    const t = window.setTimeout(() => dismiss(id), wasHovered.current ? 2000 : 3500);
    return () => window.clearTimeout(t);
  }, [id, dismiss, hovered]);
  return (
    <div
      className={"toast toast-" + kind}
      onClick={() => dismiss(id)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
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
