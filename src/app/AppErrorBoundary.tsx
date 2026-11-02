import { Component, type ErrorInfo, type ReactNode } from "react";

interface State {
  error: Error | null;
}

/** Last line of defense: a readable recovery screen instead of a blank window. */
export class AppErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[NOVA] Unrecoverable UI error", error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div role="alert" className="flex h-full flex-col items-center justify-center gap-4 bg-canvas p-10 text-center">
        <p className="text-[20px] font-semibold text-fg">NOVA ran into a problem</p>
        <p className="max-w-lg text-[13px] text-fg-muted">Your data is safe — it lives in NOVA's local database. Reloading usually fixes this.</p>
        <pre className="max-w-2xl overflow-auto rounded-[12px] border border-line bg-black/30 p-3 text-left text-[12px] text-fg-subtle select-text">{this.state.error.message}</pre>
        <button type="button" onClick={() => window.location.reload()} className="h-10 rounded-full bg-accent px-5 text-[13px] font-medium text-on-accent">
          Reload NOVA
        </button>
      </div>
    );
  }
}
