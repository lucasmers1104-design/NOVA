import { useId } from "react";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { useAccentTokens } from "@/design/theme";
import type { MetricChartProps, ChartSeries } from "./MetricChart";

/**
 * The chart itself. Its own module, and the only one that imports recharts, so
 * the library is loaded with the first chart instead of with the main window.
 */
export default function MetricChartCanvas({ samples, series, percent = true, format, axes = false }: MetricChartProps) {
  const gradientId = useId();
  const tokens = useAccentTokens();
  const colorOf = (tone: ChartSeries["tone"]) => (tone === "secondary" ? tokens.accentSecondary : tokens.accent);
  const formatValue = format ?? ((v: number) => `${Math.round(v)}%`);

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
