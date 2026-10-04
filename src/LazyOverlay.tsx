// LazyOverlay.tsx: lazy-load an overlay panel with its own Suspense and error
// boundary, so a failed chunk load shows a small "Couldn't load <panel>. Retry"
// instead of unwinding to the root ErrorBoundary (which would take every
// terminal down with it). Same idea as ViewerBoundary in Preview.tsx.
import { Component, lazy, Suspense, type ComponentType, type ReactNode } from "react";

class OverlayBoundary extends Component<{ label: string; onRetry: () => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="overlay-fail" role="alert">
        <span>Couldn’t load {this.props.label}.</span>
        <button
          className="overlay-fail-retry"
          onClick={() => { this.props.onRetry(); this.setState({ failed: false }); }}
        >
          Retry
        </button>
      </div>
    );
  }
}

/** `load` is the dynamic import, `name` the named export, `label` the human name for the error. */
export function lazyOverlay<T extends Record<string, unknown>, K extends keyof T>(
  load: () => Promise<T>,
  name: K,
  label: string,
): ComponentType<any> {
  const make = () => lazy(() => load().then((m) => ({ default: m[name] as ComponentType<any> })));
  // React caches a rejected lazy forever, so a retry needs a fresh one.
  let Lazy = make();
  const Inner = (props: any) => <Lazy {...props} />;
  return function LazyOverlay(props: any) {
    return (
      <OverlayBoundary label={label} onRetry={() => { Lazy = make(); }}>
        <Suspense fallback={null}><Inner {...props} /></Suspense>
      </OverlayBoundary>
    );
  };
}
