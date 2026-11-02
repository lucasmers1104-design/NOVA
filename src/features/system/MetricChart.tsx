import { useId } from "react";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { useAccentTokens } from "@/design/theme";
import type { MetricSample } from "./history";

type MetricKey = "cpu" | "memory" | "gpu" | "rx" | "tx";

export interface ChartSeries {
  key: MetricKey;
  label: string;
  /** Defaults to the accent; "secondary" uses the accent's companion hue. */
  tone?: "accent" | "secondary";
}

interface MetricChartProps {
  samples: MetricSample[];
  series: readonly ChartSeries[];
  /** Fixed 0–100 for percentages, or auto-scaled. */
  percent?: boolean;
  format?: (value: number) => string;
  axes?: boolean;
}

/** Sliding session-history area chart. */
export function MetricChart({ samples, series, percent = true, format, axes = false }: MetricChartProps) {
  const gradientId = useId();
  const tokens = useAccentTokens();
  const colorOf = (tone: ChartSeries["tone"]) => (tone === "secondary" ? tokens.accentSecondary : tokens.accent);
  const formatValue = format ?? ((v: number) => `${Math.round(v)}%`);

  if (samples.length < 2) {
    return <div className="flex h-full items-center justify-center text-[12px] text-fg-subtle">Collecting samples…</div>;
  }

  return (
    <ResponsiveContainer width="100%" height="100%" debounce={120}>
      <AreaChart data={samples} margin={{ top: 6, right: axes ? 8 : 0, bottom: 0, left: 0 }}>
        <defs>
          {series.map((s) => (
            <linearGradient key={s.key} id={`${gradientId}-${s.key}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={colorOf(s.tone)} stopOpacity={0.38} />
              <stop offset="100%" stopColor={colorOf(s.tone)} stopOpacity={0} />
            </linearGradient>
          ))}
        </defs>
        {axes && <CartesianGrid stroke="rgb(255 255 255 / 0.05)" vertical={false} />}
        <XAxis dataKey="t" type="number" domain={["dataMin", "dataMax"]} hide />
        <YAxis
          domain={percent ? [0, 100] : [0, "auto"]}
          hide={!axes}
          width={axes ? 64 : 0}
          tickFormatter={formatValue}
          tick={{ fill: "#646c7e", fontSize: 11 }}
          axisLine={false}
          tickLine={false}
          tickCount={4}
        />
        {axes && (
          <Tooltip
            cursor={{ stroke: "rgb(255 255 255 / 0.15)" }}
            contentStyle={{ background: "rgb(20 25 40 / 0.95)", border: "1px solid rgb(255 255 255 / 0.12)", borderRadius: 12, fontSize: 12 }}
            labelFormatter={(t) => new Date(Number(t)).toLocaleTimeString()}
            formatter={(value, name) => [formatValue(Number(value)), series.find((s) => s.key === name)?.label ?? String(name)]}
          />
        )}
        {series.map((s) => (
          <Area
            key={s.key}
            type="monotone"
            dataKey={s.key}
            stroke={colorOf(s.tone)}
            strokeWidth={2}
            fill={`url(#${gradientId}-${s.key})`}
            dot={false}
            activeDot={axes ? { r: 3 } : false}
            isAnimationActive={false}
            connectNulls
          />
        ))}
      </AreaChart>
    </ResponsiveContainer>
  );
}
