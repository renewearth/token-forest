"use client";

import { emptyObservation, mergeObservations, observationLabel, type Observation } from "@/lib/observation";
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import { formatUsage } from "@/app/_lib/usage-format";
import type { TokenBasis, Unit } from "@/lib/units";
import { useNumStyle } from "@/app/_components/NumStyleProvider";
import type { ModelDistRow } from "@/lib/queries";

type Slice = { model: string; tokens: number; color: string };

// Stable model -> categorical slot by name hash, so a slice keeps its color when
// the range filter changes the set (color follows the entity, never its rank).
// "기타" (rolled-up tail) is always neutral gray, never a hue.
function modelColor(model: string): string {
  if (model === "기타") return "var(--text-muted)";
  let h = 0;
  for (let i = 0; i < model.length; i++) h = (h * 31 + model.charCodeAt(i)) >>> 0;
  return `var(--series-${(h % 8) + 1})`;
}

const TOP = 7;

function observedValue(row: ModelDistRow): number | null {
  if (row.observation) return row.observation.value;
  // Compatibility for an older caller without observation metadata.
  return row.tokens === 0 && (row.unpricedTokens ?? 0) > 0 ? null : row.tokens;
}

function buildSlices(rows: ModelDistRow[]): Slice[] {
  const byModel = new Map<string, number>();
  for (const r of rows) {
    const value = observedValue(r);
    if (value === null || !Number.isFinite(value) || value < 0) continue;
    const label = r.model || "모델 미제공";
    byModel.set(label, (byModel.get(label) ?? 0) + value);
  }
  const sorted = [...byModel].sort((a, b) => b[1] - a[1]);
  const slices: Slice[] = sorted
    .slice(0, TOP)
    .map(([model, tokens]) => ({ model, tokens, color: modelColor(model) }));
  const restTotal = sorted.slice(TOP).reduce((s, [, v]) => s + v, 0);
  if (restTotal > 0)
    slices.push({ model: "기타", tokens: restTotal, color: modelColor("기타") });
  return slices;
}

function DonutTooltip({
  active,
  payload,
  total,
  unit,
}: {
  active?: boolean;
  payload?: Array<{ payload?: Slice }>;
  total: number;
  unit: Unit;
}) {
  if (!active || !payload?.length) return null;
  const s = payload[0].payload;
  if (!s || total <= 0) return null;
  const pct = Math.round((s.tokens / total) * 100);
  return (
    <div className="rounded-md border border-black/10 bg-[var(--surface-1)] px-3 py-2 text-xs shadow-lg dark:border-white/10">
      <div className="flex items-center gap-2">
        <span
          className="inline-block h-2.5 w-2.5 rounded-sm"
          style={{ background: s.color }}
        />
        <span className="text-[var(--text-secondary)]">{s.model}</span>
        <span className="ml-auto pl-3 font-medium tabular-nums text-[var(--text-primary)]">
          {formatUsage(s.tokens, unit)} · {pct}%
        </span>
      </div>
    </div>
  );
}

export function ModelDonut({ rows, unit = "raw", basis = "all" }: { rows: ModelDistRow[]; unit?: Unit; basis?: TokenBasis }) {
  const numStyle = useNumStyle();
  const slices = buildSlices(rows);
  const total = slices.reduce((s, x) => s + x.tokens, 0);
  const observation = mergeObservations(rows.map((row): Observation => row.observation ?? {
    ...emptyObservation(), value: observedValue(row), status: observedValue(row) === null ? "unknown" : "observed",
    unpricedTokens: row.unpricedTokens ?? 0,
  }));
  const unpriced = rows.reduce((sum, row) => sum + (row.observation?.unpricedTokens ?? row.unpricedTokens ?? 0), 0);
  const unpricedNote = unpriced > 0 ? <p className="mt-2 break-words text-xs text-[var(--text-secondary)]">미환산 원본 {formatUsage(unpriced, "raw", numStyle)}토큰 · 단가 미등록</p> : null;
  if (observation.value === null) return <div role="status" className="space-y-2 text-sm text-[var(--text-secondary)]">
    <p className="text-2xl font-semibold">—</p>
    <p>{observationLabel(observation)}</p>
    {unpricedNote}
    <p className="text-xs">표시할 관측값이 없어 모델별 비중을 계산할 수 없습니다.</p>
  </div>;

  return (
    <div>
      <p className="mb-3 text-xs text-[var(--text-secondary)]">{observationLabel(observation)} · 비중의 분모는 표시 가능한 관측값 합계입니다.</p>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
      <div className="relative shrink-0" style={{ width: 200, height: 200 }}>
        {total > 0 && <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={slices}
              dataKey="tokens"
              nameKey="model"
              innerRadius={62}
              outerRadius={92}
              paddingAngle={2}
              stroke="var(--surface-1)"
              strokeWidth={2}
            >
              {slices.map((s) => (
                <Cell key={s.model} fill={s.color} />
              ))}
            </Pie>
            <Tooltip content={<DonutTooltip total={total} unit={unit} />} />
          </PieChart>
        </ResponsiveContainer>}
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-lg font-semibold tabular-nums text-[var(--text-primary)]">
            {formatUsage(total, unit, numStyle)}
          </span>
          <span className="text-[10px] text-[var(--text-muted)]">{basis === "requests" ? "총 요청 수" : unit === "usd" ? "API 정가 환산" : unit === "ref" ? "총 환산 토큰" : "총 토큰"}</span>
        </div>
      </div>

      <ul className="flex-1 space-y-1.5 text-xs">
        {slices.map((s) => {
          const pct = total > 0 ? Math.round((s.tokens / total) * 100) : null;
          return (
            <li key={s.model} className="flex items-center gap-2">
              <span
                className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm"
                style={{ background: s.color }}
              />
              <span className="truncate text-[var(--text-secondary)]">
                {s.model}
              </span>
              <span className="ml-auto shrink-0 pl-3 tabular-nums text-[var(--text-muted)]">
                {formatUsage(s.tokens, unit, numStyle)}
              </span>
              <span className="w-9 shrink-0 text-right tabular-nums font-medium text-[var(--text-primary)]">
                {pct === null ? "—" : `${pct}%`}
              </span>
            </li>
          );
        })}
      </ul>
      </div>
      {unpricedNote}
    </div>
  );
}
