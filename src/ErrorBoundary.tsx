import { Component, type ErrorInfo, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { logError } from "./applog";

// Last-resort catch (QOL 371): without this, one render throw blanks the whole
// cockpit — including every live terminal session. The fallback deliberately
// avoids app CSS dependencies so it renders even if the theme layer is what broke.
interface Props { children: ReactNode; }
interface State { error: Error | null; }

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  // The flight-recorder write. Component stack included — the message alone
  // rarely names the component that threw, the stack always does.
  componentDidCatch(error: Error, info: ErrorInfo) {
    logError("react-render", error, info.componentStack ?? undefined);
  }

  // Best-effort: resolve the log path from Rust, reveal it in Explorer. Both
  // ends are optional (non-Tauri rigs, logging never initialised), so failures
  // die silently rather than stacking a second error on the crash screen.
  private openLog = () => {
    void invoke<string | null>("log_file_path")
      .then((p) => (p ? invoke("reveal_in_explorer", { path: p }) : undefined))
      .catch(() => {});
  };

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div style={{
        height: "100%", display: "flex", flexDirection: "column", alignItems: "center",
        justifyContent: "center", gap: 12, background: "#05080E", color: "#EAF1F8",
        fontFamily: '"Schibsted Grotesk", "Segoe UI", system-ui, sans-serif', padding: 32, textAlign: "center",
      }}>
        <div style={{ fontSize: 18, fontWeight: 700 }}>Something broke in the cockpit UI</div>
        <div style={{ fontSize: 13, color: "#94A6BC", maxWidth: 480, lineHeight: 1.5 }}>
          The interface hit an error and stopped rendering. Your agent processes may still be
          running — reload to reattach the UI. If this repeats, relaunch the app. The error and
          its stack were saved to the error log.
        </div>
        <code style={{ fontSize: 11, color: "#71839A", maxWidth: 520, overflow: "hidden", textOverflow: "ellipsis" }}>
          {String(this.state.error.message || this.state.error)}
        </code>
        <div style={{ display: "flex", gap: 10, marginTop: 6 }}>
          <button
            onClick={() => window.location.reload()}
            style={{
              font: "inherit", fontSize: 13, fontWeight: 700, color: "#05080E",
              background: "linear-gradient(125deg,#9AE9FF 0%,#43A6F5 48%,#3F6BFF 100%)",
              border: 0, borderRadius: 8, padding: "9px 18px", cursor: "pointer",
            }}
          >
            Reload interface
          </button>
          <button
            onClick={this.openLog}
            style={{
              font: "inherit", fontSize: 13, fontWeight: 600, color: "#EAF1F8",
              background: "transparent", border: "1px solid #33415A", borderRadius: 8,
              padding: "9px 18px", cursor: "pointer",
            }}
          >
            Open error log
          </button>
        </div>
      </div>
    );
  }
}
