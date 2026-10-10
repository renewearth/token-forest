"use client";

import { useState } from "react";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { MemberSeries } from "@/lib/member-series";
import type { ConvertedDailySeries } from "@/lib/queries";
import type { TokenBasis, Unit } from "@/lib/units";
import { observationLabel } from "@/lib/observation";
import { formatCompact, formatUsdCompact } from "@/app/_lib/ui";
import { formatUsage } from "@/app/_lib/usage-format";
import { useNumStyle } from "./NumStyleProvider";
import { StackedTokensChart } from "./charts";
import { EmptyState } from "./ui";

// ID-based identity stays stable when a new person joins or another is hidden.
function color(key: string) { let hash = 0; for (const ch of key) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0; return `var(--series-${hash % 6 + 1})`; }
export function UsageComparison({ people, tools, unit, basis }: {
  people: MemberSeries; tools: ConvertedDailySeries; unit: Unit; basis: TokenBasis;
}) {
  const [view, setView] = useState<"people" | "tools">("people");
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  const [showTotal, setShowTotal] = useState(true);
  const [search, setSearch] = useState("");
  const [detailDate, setDetailDate] = useState("");
  const selectedDate = people.data.some((day) => day.date === detailDate) ? detailDate : String(people.data[0]?.date ?? "");
  const totalLabel = basis === "requests" ? "수집된 전체 요청 수" : "수집된 전체 합계";
  const numStyle = useNumStyle();
  const visible = people.members.filter((m) => !hidden.has(m.key));
  const searched = people.members.filter((m) => m.name.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  const suffix = basis === "requests" ? "건" : unit === "usd" ? "USD" : unit === "ref" ? "환산 토큰" : "토큰";
  return (
    <div className="min-w-0">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-sm font-medium text-[var(--text-secondary)]">일별 사용량 추이</h3>
        <div role="group" aria-label="사용량 보기 방식" className="flex flex-wrap gap-1 rounded-lg bg-[var(--surface-2)] p-1">
          {([["people", "구성원별 사용 흐름"], ["tools", "도구별 누적"]] as const).map(([key, label]) => (
            <button key={key} type="button" aria-pressed={view === key} onClick={() => setView(key)}
              className={`rounded-md px-3 py-2 text-xs ${view === key ? "bg-[var(--surface-1)] font-semibold shadow-sm" : "text-[var(--text-muted)]"}`}>{label}</button>
          ))}
        </div>
      </div>
      <p className="mb-4 text-xs text-[var(--text-muted)]">굵은 점선은 수집된 전체 합계입니다. 범례 선택과 검색은 선 표시만 바꾸며 전체 합계에는 영향이 없습니다. 빈 날짜는 수집 미확인이며 선을 연결하지 않습니다.</p>
      {view === "tools" ? <StackedTokensChart showTotal={showTotal} totalLabel={totalLabel} data={tools.data} tools={tools.tools} observations={tools.observations} unit={suffix} valueFormat={unit === "usd" ? "usd" : "count"} /> : (
        visible.length || showTotal ? <div role="group" aria-label="구성원별 일별 사용량 그래프">
          <ResponsiveContainer width="100%" height={300}>
            <LineChart data={people.data} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
              <CartesianGrid stroke="var(--grid)" vertical={false} />
              <XAxis dataKey="date" tickFormatter={(v: string) => v.slice(5)} minTickGap={24} tick={{ fill: "var(--text-muted)", fontSize: 11 }} />
              <YAxis allowDecimals={basis !== "requests"} width={56} tickFormatter={(v: number) => unit === "usd" ? formatUsdCompact(v) : formatCompact(v, numStyle)} tick={{ fill: "var(--text-muted)", fontSize: 11 }} />
              <Tooltip filterNull={false} content={({ active, label }) => {
                if (!active || label == null) return null;
                const states = people.observations[String(label)];
                if (!states) return null;
                const entries = [...(showTotal ? [{ key: "__total", name: totalLabel }] : []), ...visible];
                return <div className="max-h-64 max-w-[300px] overflow-auto rounded-md border border-[var(--border)] bg-[var(--surface-1)] p-3 text-xs shadow-lg">
                  <p className="mb-2 font-medium">{String(label)}</p>
                  {entries.map((m) => <p key={m.key} className="py-1">{m.name}: {formatUsage(states[m.key]?.value, unit, numStyle)} {suffix}<br />{states[m.key] && observationLabel(states[m.key])}</p>)}
                </div>;
              }} />
              {showTotal && <Line name={totalLabel} dataKey="__total" type="linear" connectNulls={false} stroke="var(--text-primary)" strokeWidth={3} strokeDasharray="8 4" dot={{ r: 2 }} isAnimationActive={false} />}
              {people.members.map((m, i) => hidden.has(m.key) ? null : <Line key={m.key} name={m.name} dataKey={m.key} type="linear" connectNulls={false} stroke={color(m.key)} strokeDasharray={i >= 6 ? `${2 + Math.floor(i / 6) * 2} 3` : undefined} strokeWidth={2} dot={{ r: 2 }} isAnimationActive={false} />)}
            </LineChart>
          </ResponsiveContainer>
        </div> : <EmptyState message="표시할 선을 선택하세요." />
      )}
      <div className="mt-4 flex flex-wrap gap-2 text-xs">
        <button type="button" aria-pressed={showTotal} onClick={() => setShowTotal((v) => !v)} className="rounded-lg border border-[var(--border)] px-3 py-2">전체 합계 표시 {showTotal ? "켜짐" : "꺼짐"} · {formatUsage(people.observation.value, unit, numStyle)} {suffix}</button>
        {view === "people" && <>
          <label className="flex min-w-0 items-center gap-2">구성원 검색<input value={search} onChange={(e) => setSearch(e.target.value)} className="min-w-0 max-w-40 rounded border border-[var(--border)] bg-[var(--surface-1)] px-2 py-2" /></label>
          <button type="button" className="rounded border border-[var(--border)] px-3 py-2" onClick={() => setHidden(new Set())}>전체 선택</button>
          <button type="button" className="rounded border border-[var(--border)] px-3 py-2" onClick={() => setHidden(new Set(people.members.map((m) => m.key)))}>전체 해제</button>
        </>}
      </div>
      {view === "people" && <div role="group" aria-label="표시할 구성원" className="mt-3 flex max-h-64 flex-wrap gap-2 overflow-y-auto">
        {searched.map((m) => <button key={m.key} type="button" aria-pressed={!hidden.has(m.key)}
          onClick={() => setHidden((previous) => { const next = new Set(previous); if (next.has(m.key)) next.delete(m.key); else next.add(m.key); return next; })}
          className={`min-w-0 max-w-full rounded-lg border px-3 py-2 text-left text-xs ${hidden.has(m.key) ? "border-transparent bg-[var(--surface-2)] text-[var(--text-muted)]" : "border-[var(--border)]"}`}>
          <span className="flex items-center gap-2"><span aria-hidden="true" className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: color(m.key) }} /><span className="break-words">{m.name}</span></span>
          <span className="mt-1 block tabular-nums">{formatUsage(m.total, unit, numStyle)} {suffix} · {observationLabel(m.observation)}</span>
          <span className="mt-1 block">{m.observation.hasRecord ? "기록 있음" : "기록 미확인"}</span>
        </button>)}
        {!searched.length && <p className="text-xs">일치하는 구성원이 없습니다.</p>}
      </div>}
      <p className="mt-3 text-[11px] text-[var(--text-muted)]">기타 집계는 미연결·비표시 구성원의 관측값입니다. 신원은 표시하지 않으며 익명성을 보장하는 기능은 아닙니다.</p>
      <details className="mt-3 text-xs"><summary className="cursor-pointer">날짜별 값·수집 상태 표로 보기</summary>
        <label className="mt-2 flex items-center gap-2">날짜 선택<select value={selectedDate} onChange={(e) => setDetailDate(e.target.value)} className="rounded border border-[var(--border)] bg-[var(--surface-1)] p-2">{people.data.map((day) => <option key={String(day.date)} value={String(day.date)}>{String(day.date)}</option>)}</select></label>
        <div className="mt-2 max-h-80 overflow-auto"><table className="w-full text-left"><thead><tr><th>날짜</th><th>항목</th><th>수집 합계</th><th>상태</th></tr></thead><tbody>
          {people.data.filter((day) => day.date === selectedDate).map((day) => { const date = String(day.date); const states = people.observations[date]; return [{ key: "__total", name: totalLabel }, ...people.members].map((m) => <tr key={`${date}-${m.key}`}><td className="whitespace-nowrap pr-2">{date}</td><td className="pr-2">{m.name}</td><td className="pr-2">{formatUsage(states[m.key]?.value, unit, numStyle)} {suffix}</td><td>{observationLabel(states[m.key])}</td></tr>); })}
        </tbody></table></div>
      </details>
    </div>
  );
}
