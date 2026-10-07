import { formatNumber } from "@/app/_lib/ui";
import { formatUsage } from "@/app/_lib/usage-format";
import { unpricedNote, type Unit } from "@/lib/units";
import type { WowRow } from "@/lib/queries";

// These weekly windows include an unfinished week and cannot prove complete
// source coverage. Show observed absolute values; never score their direction.
export function WowTable({ rows, unit = "raw" }: { rows: WowRow[]; max?: number; unit?: Unit }) {
  return <div className="overflow-x-auto"><table className="w-full text-sm">
    <thead><tr className="text-left text-xs text-[var(--text-muted)]"><th className="py-2">구성원</th><th className="py-2 text-right">이번 주 관측값</th><th className="py-2 text-right">지난 주 관측값</th><th className="py-2 text-right">비교 조건</th></tr></thead>
    <tbody>{[...rows].sort((a,b) => a.memberId.localeCompare(b.memberId)).map(r => <tr key={r.memberId} className="border-t border-[var(--border)]">
      <td className="py-2">{r.name}</td>
      <td className="py-2 text-right tabular-nums">{formatUsage(r.observation ? r.observation.value : null, unit)}{(r.unpricedTokens ?? 0) > 0 && <p className="text-xs">{unpricedNote(formatNumber(r.unpricedTokens ?? 0))}</p>}</td>
      <td className="py-2 text-right tabular-nums">{formatUsage(r.previousObservation ? r.previousObservation.value : null, unit)}{(r.prevUnpricedTokens ?? 0) > 0 && <p className="text-xs">{unpricedNote(formatNumber(r.prevUnpricedTokens ?? 0))}</p>}</td>
      <td className="py-2 text-right text-xs text-[var(--text-muted)]">비교 조건 확인 필요<br />수집 범위 미확인 · 이번 주 진행 중</td>
    </tr>)}</tbody>
  </table></div>;
}
