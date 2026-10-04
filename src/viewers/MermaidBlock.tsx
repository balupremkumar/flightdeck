import { useEffect, useId, useRef, useState } from "react";
import "./viewers.css";

type State =
  | { kind: "loading" }
  | { kind: "ok"; svg: string }
  | { kind: "error"; message: string };

export default function MermaidBlock({ source, theme }: { source: string; theme: "light" | "dark" }) {
  const reactId = useId().replace(/[^a-zA-Z0-9]/g, "");
  const seq = useRef(0);
  const [state, setState] = useState<State>({ kind: "loading" });
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const n = ++seq.current;
    setState({ kind: "loading" });
    (async () => {
      try {
        const mermaid = (await import("mermaid")).default;
        mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: theme === "dark" ? "dark" : "default" });
        const { svg } = await mermaid.render(`mmd-${reactId}-${n}`, source);
        if (!cancelled) setState({ kind: "ok", svg });
      } catch (e) {
        if (!cancelled) setState({ kind: "error", message: e instanceof Error ? e.message : String(e) });
        // mermaid leaves a stray error node in the body on failure
        document.getElementById(`dmmd-${reactId}-${n}`)?.remove();
      }
    })();
    return () => { cancelled = true; };
  }, [source, theme, reactId]);

  const copy = () => {
    navigator.clipboard?.writeText(source).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  };

  return (
    <div className="mermaid-block">
      <div className="mermaid-bar">
        <button type="button" className="mermaid-copy" onClick={copy} aria-live="polite">
          {copied ? "Copied" : "Copy source"}
        </button>
      </div>
      {state.kind === "loading" && <div className="mermaid-loading" role="status">Rendering diagram...</div>}
      {state.kind === "ok" && (
        <div className="mermaid-svg" role="img" aria-label="Mermaid diagram" dangerouslySetInnerHTML={{ __html: state.svg }} />
      )}
      {state.kind === "error" && (
        <div className="mermaid-error" role="alert">
          <div className="mermaid-error-msg">Diagram failed to render: {state.message}</div>
          <pre>{source}</pre>
        </div>
      )}
    </div>
  );
}
