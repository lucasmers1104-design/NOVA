import type { LucideIcon } from "lucide-react";
import type { ComponentType } from "react";

export type WidgetCategory = "overview" | "system" | "time" | "productivity" | "media" | "information";

export const CATEGORY_LABELS: Record<WidgetCategory, string> = {
  overview: "Overview",
  system: "System",
  time: "Time",
  productivity: "Productivity",
  media: "Media",
  information: "Information",
};

export interface WidgetSize {
  /** Columns on the 12-column dashboard grid. */
  w: number;
  /** Grid rows (96 px each, plus gaps). */
  h: number;
}

/**
 * Where a widget's data comes from. Surfaced to the user so it is always
 * clear which widgets touch the network.
 */
export type WidgetDataSource = "local" | "system" | "network";

interface ConfigFieldBase {
  key: string;
  label: string;
  description?: string;
}

export interface BooleanConfigField extends ConfigFieldBase {
  type: "boolean";
  default: boolean;
}

export interface SelectConfigField extends ConfigFieldBase {
  type: "select";
  default: string;
  options: readonly { value: string; label: string }[];
}

export type ConfigField = BooleanConfigField | SelectConfigField;

/** Resolved widget configuration: every schema key present with a valid value. */
export type WidgetConfig = Record<string, boolean | string>;

export interface WidgetDefinition {
  id: string;
  name: string;
  description: string;
  category: WidgetCategory;
  icon: LucideIcon;
  defaultSize: WidgetSize;
  minSize: WidgetSize;
  maxSize: WidgetSize;
  dataSource: WidgetDataSource;
  /** User-facing options; an empty schema means the widget has no settings. */
  configSchema: readonly ConfigField[];
  component: ComponentType;
}

/** A placed widget on a dashboard layout. `config` is raw, untrusted storage data. */
export interface WidgetInstance extends WidgetSize {
  instanceId: string;
  widgetId: string;
  config: Record<string, unknown>;
}
