"use client";

import { observationLabel, type Observation } from "@/lib/observation";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  formatCompact,
  formatNumber,
  formatUsdCompact,
  toolColor,
  toolLabel,
} from "@/app/_lib/ui";
import { formatUsage } from "@/app/_lib/usage-format";
import { useNumStyle } from "@/app/_components/NumStyleProvider";

type Row = Record<string, string | number | null>;

const AXIS = "var(--text-muted)";
const GRID = "var(--grid)";

const axisProps = {
  stroke: "var(--axis)",
  tick: { fill: AXIS, fontSize: 11 },
  tickLine: false,
} as const;

function shortDate(v: string): string {
  // "2026-07-15" -> "07-15"; weeks "2026-W28" pass through.
  return v.length === 10 ? v.slice(5) : v;
}

const METRIC_LABELS: Record<string, string> = {
  tokens: "토큰",
  requests: "요청",
  observedRequests: "수집된 요청",
  usd: "API 정가 환산",
  ref: "기준 모델 환산",
};

// How chart values read: counts (tokens, requests, people) or list-price
// dollars (unit "usd", src/lib/units.ts). A string, not a formatter function,
// so server components can pass it.
export type ValueFormat = "count" | "usd";

function seriesLabel(key: string): string {
  return METRIC_LABELS[key] ?? toolLabel(key);
}

// One tooltip style for every chart: surface card, text-token ink, colored dot
// carries identity (never colored text).
function ChartTooltip({
  active,
  payload,
  label,
  unit,
  valueFormat = "count",
  observations,
}: {
  active?: boolean;
  payload?: Array<{ dataKey?: string | number; name?: string; value?: number | null; color?: string }>;
  label?: string | number;
  unit: string;
  valueFormat?: ValueFormat;
  observations?: Record<string, Record<string, Observation>>;
}) {
  if (!active || !payload?.length) return null;
  const rows = payload;
  if (!rows.length) return null;
  return (
    <div className="rounded-md border border-black/10 bg-[var(--surface-1)] px-3 py-2 text-xs shadow-lg dark:border-white/10">
      <div className="mb-1 font-medium text-[var(--text-secondary)]">
        {shortDate(String(label))}
      </div>
      <ul className="space-y-1">
        {rows.map((p) => (
          <li key={String(p.dataKey)} className="flex items-center gap-2">
            <span
              className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm"
              style={{ background: String(p.color) }}
            />
            <span className="text-[var(--text-secondary)]">
              {p.dataKey === "__total" ? p.name : seriesLabel(String(p.dataKey))}
              {observations?.[String(label)]?.[String(p.dataKey)] && <span className="block">{observationLabel(observations[String(label)][String(p.dataKey)])}</span>}
            </span>
            <span className="ml-auto pl-3 font-medium tabular-nums text-[var(--text-primary)]">
              {valueFormat === "usd"
                ? formatUsage(p.value, "usd")
                : p.value == null ? "— · 수집 미확인" : `${formatNumber(p.value)} ${unit}`}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function Legend({ tools }: { tools: string[] }) {
  if (tools.length < 2) return null;
  return (
    <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5">
      {tools.map((t) => (
        <li key={t} className="flex items-center gap-1.5 text-xs text-[var(--text-secondary)]">
          <span
            className="inline-block h-2.5 w-2.5 rounded-sm"
            style={{ background: toolColor(t) }}
          />
          {toolLabel(t)}
        </li>
      ))}
    </ul>
  );
}

// Stacked columns of tokens by tool over time. A 2px surface stroke on each
// segment is the surface-gap that keeps touching segments distinct.
export function StackedTokensChart({
  data,
  tools,
  height = 280,
  unit = "토큰",
  valueFormat = "count",
  showTotal = false,
  totalLabel = "수집된 전체 합계",
  observations,
}: {
  data: Row[];
  tools: string[];
  height?: number;
  unit?: string;
  valueFormat?: ValueFormat;
  showTotal?: boolean;
  totalLabel?: string;
  observations?: Record<string, Record<string, Observation>>;
}) {
  const numStyle = useNumStyle();
  const chartData = showTotal ? data.map((row) => ({ ...row, __total: Object.hasOwn(row, "__total") ? row.__total : tools.some((tool) => typeof row[tool] === "number") ? tools.reduce((sum, tool) => sum + Number(row[tool] ?? 0), 0) : null })) : data;
  return (
    <div>
      <ResponsiveContainer width="100%" height={height}>
        <ComposedChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid stroke={GRID} vertical={false} />
          <XAxis
            dataKey="date"
            tickFormatter={shortDate}
            minTickGap={24}
            {...axisProps}
          />
          <YAxis allowDecimals={unit !== "건"}
            width={52}
            tickFormatter={(v: number) =>
              valueFormat === "usd" ? formatUsdCompact(v) : formatCompact(v, numStyle)
            }
            {...axisProps}
          />
          <Tooltip filterNull={false}
            cursor={{ fill: "var(--grid)", opacity: 0.4 }}
            content={<ChartTooltip unit={unit} valueFormat={valueFormat} observations={observations} />}
          />
          {tools.map((t, i) => (
            <Bar
              key={t}
              dataKey={t}
              stackId="tokens"
              fill={toolColor(t)}
              stroke="var(--surface-1)"
              strokeWidth={2}
              maxBarSize={24}
              radius={i === tools.length - 1 ? [3, 3, 0, 0] : undefined}
            />
          ))}
          {showTotal && <Line dataKey="__total" name={totalLabel} type="linear" stroke="var(--text-primary)" strokeWidth={3} strokeDasharray="8 4" dot={false} isAnimationActive={false} />}
        </ComposedChart>
      </ResponsiveContainer>
      <Legend tools={tools} />
      {showTotal && <p className="mt-2 flex items-center gap-2 text-xs text-[var(--text-secondary)]"><span aria-hidden="true" className="w-5 border-t-2 border-dashed border-current" />{totalLabel}</p>}
    </div>
  );
}

// Grouped columns: weekly active members per tool (adoption).
export function AdoptionChart({
  data,
  tools,
  height = 260,
}: {
  data: Row[];
  tools: string[];
  height?: number;
}) {
  return (
    <div>
      <ResponsiveContainer width="100%" height={height}>
        <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid stroke={GRID} vertical={false} />
          <XAxis dataKey="date" tickFormatter={shortDate} minTickGap={16} {...axisProps} />
          <YAxis width={32} allowDecimals={false} {...axisProps} />
          <Tooltip filterNull={false}
            cursor={{ fill: "var(--grid)", opacity: 0.4 }}
            content={<ChartTooltip unit="명" />}
          />
          {tools.map((t) => (
            <Bar key={t} dataKey={t} fill={toolColor(t)} maxBarSize={18} radius={[3, 3, 0, 0]} />
          ))}
        </BarChart>
      </ResponsiveContainer>
      <Legend tools={tools} />
    </div>
  );
}

// Single-series area trend (requests overview, member tokens/requests detail).
export function TrendArea({
  data,
  dataKey,
  color = "var(--series-1)",
  unit,
  height = 240,
  valueFormat = "count",
}: {
  data: Row[];
  dataKey: string;
  color?: string;
  unit: string;
  height?: number;
  valueFormat?: ValueFormat;
}) {
  const gradId = `grad-${dataKey}`;
  const numStyle = useNumStyle();
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.18} />
            <stop offset="100%" stopColor={color} stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <CartesianGrid stroke={GRID} vertical={false} />
        <XAxis dataKey="date" tickFormatter={shortDate} minTickGap={24} {...axisProps} />
        <YAxis allowDecimals={unit !== "건" && unit !== "요청"}
          width={52}
          tickFormatter={(v: number) =>
            valueFormat === "usd" ? formatUsdCompact(v) : formatCompact(v, numStyle)
          }
          {...axisProps}
        />
        <Tooltip filterNull={false}
          cursor={{ stroke: "var(--axis)" }}
          content={<ChartTooltip unit={unit} valueFormat={valueFormat} />}
        />
        <Area
          type="linear"
          connectNulls={false}
          dataKey={dataKey}
          stroke={color}
          strokeWidth={2}
          fill={`url(#${gradId})`}
          dot={false}
          activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--surface-1)" }}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}
