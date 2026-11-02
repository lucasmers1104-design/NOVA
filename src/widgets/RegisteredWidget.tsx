import { resolveConfig, WidgetConfigContext } from "./config";
import { getWidget } from "./registry";
import { WidgetBoundary } from "./WidgetBoundary";

/** Renders a registered widget outside the dashboard (pages, previews) with validated config. */
export function RegisteredWidget({ id, config }: { id: string; config?: Record<string, unknown> }) {
  const definition = getWidget(id);
  if (!definition) return null;
  const Widget = definition.component;
  return (
    <WidgetBoundary name={definition.name}>
      <WidgetConfigContext.Provider value={resolveConfig(definition.configSchema, config)}>
        <Widget />
      </WidgetConfigContext.Provider>
    </WidgetBoundary>
  );
}
