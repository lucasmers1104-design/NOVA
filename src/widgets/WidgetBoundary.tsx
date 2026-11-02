import { TriangleAlert } from "lucide-react";
import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "@/components/ui/Button";

interface Props {
  name: string;
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/** Contains a crashing widget so the rest of the dashboard keeps working. */
export class WidgetBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[NOVA] Widget "${this.props.name}" crashed`, error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div role="alert" className="glass flex h-full flex-col items-center justify-center gap-2 rounded-widget p-5 text-center">
        <TriangleAlert size={18} className="text-warning" aria-hidden />
        <p className="text-[13px] font-medium text-fg">{this.props.name} stopped working</p>
        <p className="max-w-60 text-[12px] text-fg-muted">{this.state.error.message}</p>
        <Button size="sm" onClick={() => this.setState({ error: null })}>
          Reload widget
        </Button>
      </div>
    );
  }
}
