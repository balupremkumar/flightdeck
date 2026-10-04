import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useUI } from "../ui";
import { fitScale, stepZoom, zoomLabel, clampZoom } from "./mediaMath";
import "./media.css";

// Images (incl. SVG) are shown through <img src=asset://...>. SVG is never
// inlined, so embedded script cannot run. The asset protocol is scoped in Rust
// (readscope.rs) to the same roots as file reads; a load error therefore usually
// means "outside the read scope" or a missing file.

function copyPath(path: string) {
  navigator.clipboard
    .writeText(path)
    .then(() => useUI.getState().pushToast("success", "Path copied"))
    .catch(() => useUI.getState().pushToast("error", "Couldn’t copy the path."));
}

export default function ImageView({ path }: { path: string }) {
  const stageRef = useRef<HTMLDivElement>(null);
  const [src, setSrc] = useState(() => convertFileSrc(path));
  const [failed, setFailed] = useState(false);
  const [nat, setNat] = useState<{ w: number; h: number } | null>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  // null = fit to window; number = explicit scale.
  const [zoom, setZoom] = useState<number | null>(null);
  const [panning, setPanning] = useState(false);
  const drag = useRef<{ x: number; y: number; sl: number; st: number } | null>(null);

  useEffect(() => {
    setSrc(convertFileSrc(path));
    setFailed(false);
    setNat(null);
    setZoom(null);
  }, [path]);

  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const measure = () => setBox({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [failed]);

  const scale = zoom ?? (nat ? fitScale(nat.w, nat.h, box.w, box.h) : 1);
  const scaleRef = useRef(scale);
  scaleRef.current = scale;

  // Ctrl+wheel zoom needs a non-passive listener to suppress page zoom.
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      setZoom(stepZoom(scaleRef.current, e.deltaY < 0 ? 1 : -1));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [failed]);

  const zoomIn = useCallback(() => setZoom(stepZoom(scaleRef.current, 1)), []);
  const zoomOut = useCallback(() => setZoom(stepZoom(scaleRef.current, -1)), []);

  const w = nat ? nat.w * scale : undefined;
  const h = nat ? nat.h * scale : undefined;
  const pannable = !!nat && !!w && !!h && (w > box.w || h > box.h);

  if (failed) {
    return (
      <div className="img-viewer">
        <div className="media-fallback" role="alert">
          <div className="media-fallback-title">Couldn’t load this image</div>
          <div>It may be outside the folders Flightdeck can read, missing, or not a supported format.</div>
          <div className="media-fallback-path">{path}</div>
          <div className="media-fallback-actions">
            <button className="img-btn" onClick={() => copyPath(path)}>Copy path</button>
            <button className="img-btn" onClick={() => { setFailed(false); setSrc(convertFileSrc(path) + "?r=" + Date.now()); }}>Retry</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="img-viewer">
      <div className="img-bar" role="toolbar" aria-label="Image controls">
        <button className="img-btn" onClick={zoomOut} aria-label="Zoom out" title="Zoom out (Ctrl+wheel)">−</button>
        <span className="img-zoom" aria-live="polite">{zoomLabel(scale)}</span>
        <button className="img-btn" onClick={zoomIn} aria-label="Zoom in" title="Zoom in (Ctrl+wheel)">+</button>
        <button className="img-btn" aria-pressed={zoom === null} onClick={() => setZoom(null)}>Fit</button>
        <button className="img-btn" aria-pressed={zoom === 1} onClick={() => setZoom(clampZoom(1))}>100%</button>
      </div>
      <div
        ref={stageRef}
        className={`img-stage${pannable ? " pannable" : ""}${panning ? " panning" : ""}`}
        onPointerDown={(e) => {
          const el = stageRef.current;
          if (!pannable || !el || e.button !== 0) return;
          drag.current = { x: e.clientX, y: e.clientY, sl: el.scrollLeft, st: el.scrollTop };
          el.setPointerCapture(e.pointerId);
          setPanning(true);
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          const el = stageRef.current;
          if (!d || !el) return;
          el.scrollLeft = d.sl - (e.clientX - d.x);
          el.scrollTop = d.st - (e.clientY - d.y);
        }}
        onPointerUp={() => { drag.current = null; setPanning(false); }}
        onPointerCancel={() => { drag.current = null; setPanning(false); }}
      >
        <img
          src={src}
          alt={path}
          draggable={false}
          width={w}
          height={h}
          style={nat ? undefined : { visibility: "hidden" }}
          onLoad={(e) => {
            const i = e.currentTarget;
            setNat({ w: i.naturalWidth || 300, h: i.naturalHeight || 150 });
          }}
          onError={() => setFailed(true)}
        />
      </div>
      <div className="img-foot">
        <span>{nat ? `${nat.w} × ${nat.h} px` : "Loading…"}</span>
      </div>
    </div>
  );
}
