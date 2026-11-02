import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import type { ReactElement } from "react";
import { resolveConfig, WidgetConfigContext } from "@/widgets/config";
import { getWidget } from "@/widgets/registry";

/** Renders with a fresh, non-retrying query client per test. */
export function renderWithQuery(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

/** Renders a registered widget the way the dashboard does, with resolved config. */
export function renderWidget(widgetId: string, config: Record<string, unknown> = {}) {
  const definition = getWidget(widgetId);
  if (!definition) throw new Error(`Unknown widget ${widgetId}`);
  const Widget = definition.component;
  return renderWithQuery(
    <WidgetConfigContext.Provider value={resolveConfig(definition.configSchema, config)}>
      <Widget />
    </WidgetConfigContext.Provider>,
  );
}
