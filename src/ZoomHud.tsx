// ZoomHud.tsx — transient centered chip ("110%") shown for ~800ms after a
// whole-app zoom change (Ctrl+=/-/0 or Settings > UI size). Owner feedback
// item 3. Mount once: <ZoomHud />.
import { useEffect, useRef, useState } from "react";
import { useUI } from "./ui";

const HUD_MS = 800;

export function ZoomHud() {
  const zoomHud = useUI((s) => s.zoomHud);
  const [visible, setVisible] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    if (!zoomHud) return;
    setVisible(true);
    clearTimeout(timer.current);
    // Keyed on `id`, not `value` — pressing the same edge step twice in a row
    // (already at 150%, Ctrl+= again) must still restart the hide-timer.
    timer.current = setTimeout(() => setVisible(false), HUD_MS);
    return () => clearTimeout(timer.current);
  }, [zoomHud]);

  if (!zoomHud || !visible) return null;

  return (
    <div className="zoom-hud" role="status" aria-live="polite">
      {Math.round(zoomHud.value * 100)}%
    </div>
  );
}
