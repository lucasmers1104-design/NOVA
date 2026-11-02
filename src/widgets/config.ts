import { createContext, useContext } from "react";
import type { ConfigField, WidgetConfig, WidgetDefinition, WidgetSize } from "./types";

/**
 * Validates raw stored config against a schema: unknown keys are dropped and
 * wrong-typed or out-of-range values fall back to the field default.
 */
export function resolveConfig(schema: readonly ConfigField[], raw: Record<string, unknown> | undefined): WidgetConfig {
  const config: WidgetConfig = {};
  for (const field of schema) {
    const value = raw?.[field.key];
    if (field.type === "boolean") {
      config[field.key] = typeof value === "boolean" ? value : field.default;
    } else {
      config[field.key] = typeof value === "string" && field.options.some((o) => o.value === value) ? value : field.default;
    }
  }
  return config;
}

/** Keeps a size within the widget's declared bounds. */
export function clampSize(definition: Pick<WidgetDefinition, "minSize" | "maxSize">, size: WidgetSize): WidgetSize {
  const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, Math.round(v)));
  return {
    w: clamp(size.w, definition.minSize.w, definition.maxSize.w),
    h: clamp(size.h, definition.minSize.h, definition.maxSize.h),
  };
}

export const WidgetConfigContext = createContext<WidgetConfig>({});

/**
 * The resolved configuration of the widget instance being rendered. The type
 * parameter documents the widget's own schema; values are already validated.
 */
export function useWidgetConfig<T extends WidgetConfig>(): T {
  return useContext(WidgetConfigContext) as T;
}
