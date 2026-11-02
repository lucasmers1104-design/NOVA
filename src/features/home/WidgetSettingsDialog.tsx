import { useId } from "react";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { Switch } from "@/components/ui/Switch";
import { useActiveLayout, useDashboard } from "@/features/dashboard/store";
import { resolveConfig } from "@/widgets/config";
import { getWidget } from "@/widgets/registry";
import type { ConfigField } from "@/widgets/types";

/** Settings form generated from the widget's config schema; changes apply live. */
export function WidgetSettingsDialog({ instanceId, onClose }: { instanceId: string | null; onClose: () => void }) {
  const layout = useActiveLayout();
  const updateWidgetConfig = useDashboard((s) => s.updateWidgetConfig);
  const instance = layout?.widgets.find((w) => w.instanceId === instanceId);
  const definition = instance ? getWidget(instance.widgetId) : undefined;
  const open = Boolean(instance && definition);
  const config = definition && instance ? resolveConfig(definition.configSchema, instance.config) : {};

  const restoreDefaults = () => {
    if (!definition || !instance) return;
    updateWidgetConfig(instance.instanceId, Object.fromEntries(definition.configSchema.map((field) => [field.key, field.default])));
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={definition ? `${definition.name} settings` : "Widget settings"}
      description="Changes apply immediately."
      footer={
        <>
          <Button size="sm" variant="ghost" onClick={restoreDefaults}>
            Restore defaults
          </Button>
          <Button size="sm" variant="primary" onClick={onClose}>
            Done
          </Button>
        </>
      }
    >
      <div className="divide-y divide-line">
        {definition?.configSchema.map((field) => (
          <FieldRow
            key={field.key}
            field={field}
            value={config[field.key]}
            onChange={(value) => instance && updateWidgetConfig(instance.instanceId, { [field.key]: value })}
          />
        ))}
      </div>
    </Dialog>
  );
}

export function FieldRow({ field, value, onChange }: { field: ConfigField; value: unknown; onChange: (value: boolean | string) => void }) {
  const selectId = useId();
  return (
    <div className="flex items-center justify-between gap-6 py-3.5 first:pt-0 last:pb-0">
      <div className="min-w-0">
        {field.type === "select" && field.options.length > 3 ? (
          <label htmlFor={selectId} className="text-[13.5px] font-medium text-fg">
            {field.label}
          </label>
        ) : (
          <p className="text-[13.5px] font-medium text-fg">{field.label}</p>
        )}
        {field.description && <p className="mt-0.5 text-[12px] text-fg-muted">{field.description}</p>}
      </div>
      {field.type === "boolean" ? (
        <Switch label={field.label} checked={value === true} onChange={onChange} />
      ) : field.options.length <= 3 ? (
        <SegmentedControl label={field.label} value={String(value)} options={field.options} onChange={onChange} />
      ) : (
        <select
          id={selectId}
          value={String(value)}
          onChange={(event) => onChange(event.target.value)}
          className="h-9 min-w-44 rounded-full border border-white/[0.1] bg-white/[0.06] px-3 text-[13px] text-fg outline-none focus:border-line-strong [&>option]:bg-canvas-raised"
        >
          {field.options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}
