import { useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { openPath } from "@tauri-apps/plugin-opener";
import { isRemotePath } from "../linkify";
import { useUI } from "../ui";
import "./media.css";

// WebView2's built-in PDF viewer renders an asset:// URL inside an <iframe>.
// Whether it actually does can only be confirmed in the real app, so this is
// defensive: a load event that never fires within LOAD_MS, an error event, or a
// Chromium "blocked" page all land on the fallback panel. Note a cross-origin
// iframe's load event also fires for an error page, so the timeout is the main
// guard and the fallback always offers Open externally.

const LOAD_MS = 8000;

function copyPath(path: string) {
  navigator.clipboard
    .writeText(path)
    .then(() => useUI.getState().pushToast("success", "Path copied"))
    .catch(() => useUI.getState().pushToast("error", "Couldn’t copy the path."));
}

export default function PdfView({ path }: { path: string }) {
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const remote = isRemotePath(path);

  useEffect(() => {
    setFailed(remote);
    setLoaded(false);
    if (remote) return;
    timer.current = window.setTimeout(() => setFailed(true), LOAD_MS);
    return () => window.clearTimeout(timer.current);
  }, [path, remote]);

  const open = () => {
    if (remote) return;
    openPath(path).catch(() => useUI.getState().pushToast("error", "Couldn’t open the file."));
  };

  if (failed) {
    return (
      <div className="pdf-viewer">
        <div className="media-fallback" role="alert">
          <div className="media-fallback-title">PDF preview isn’t available here</div>
          <div className="media-fallback-path">{path}</div>
          <div className="media-fallback-actions">
            {!remote && <button className="img-btn" onClick={open}>Open externally</button>}
            <button className="img-btn" onClick={() => copyPath(path)}>Copy path</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="pdf-viewer">
      <iframe
        className="pdf-frame"
        title={path}
        src={convertFileSrc(path)}
        // No allow-scripts/same-origin: the PDF plugin renders regardless of
        // sandbox only in some builds, so no sandbox attribute; content is
        // read-scoped local files and CSP frame-src is limited to asset:.
        onLoad={() => {
          setLoaded(true);
          window.clearTimeout(timer.current);
        }}
        onError={() => setFailed(true)}
        data-loaded={loaded ? "1" : "0"}
      />
    </div>
  );
}
