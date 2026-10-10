import Link from "next/link";
import { STAGE_LEGEND, milestoneGroups, STATE_LEGEND } from "@/lib/forest-symbols";

// 홈 숲 아래 컴팩트 범례. 네이티브 <details>(클라이언트 JS 불필요), 기본 접힘.
// 이모지는 정보이므로 인접 텍스트 라벨 동반(호버 비의존·모바일 OK).
export default function SymbolLegend() {
  const groups = milestoneGroups();
  const rowCls = "flex flex-wrap gap-x-3 gap-y-1 text-[var(--text-secondary)]";
  const headCls = "mb-1 text-xs font-semibold text-[var(--accent-strong)]";
  return (
    <details className="rounded-xl border border-black/10 bg-[var(--surface-1)] text-sm dark:border-white/10">
      <summary className="cursor-pointer select-none px-4 py-2.5 font-medium text-[var(--text-primary)]">
        이 숲의 기호
      </summary>
      <div className="space-y-3 px-4 pb-4">
        <div>
          <div className={headCls}>나무 단계</div>
          <div className={rowCls}>
            {STAGE_LEGEND.map((s) => (
              <span key={s.label} className="whitespace-nowrap">
                <span className="mr-0.5">{s.emoji}</span> {s.label}
              </span>
            ))}
          </div>
        </div>
        {groups.map((g) => (
          <div key={g.axis}>
            <div className={headCls}>
              {g.axisLabel}{g.axis === "streak" ? " · 나무 성장 기록" : ""}{" "}
              <span className="font-normal text-[var(--text-muted)]">— {g.meaning}</span>
            </div>
            <div className={rowCls}>
              {g.tiers.map((t) => (
                <span key={t.emoji} className="whitespace-nowrap">
                  <span className="mr-0.5">{t.emoji}</span> {t.label}
                </span>
              ))}
            </div>
          </div>
        ))}
        <div>
          <div className={headCls}>상태</div>
          <div className={rowCls}>
            {STATE_LEGEND.map((s) => (
              <span key={s.emoji} className="whitespace-nowrap">
                <span className="mr-0.5">{s.emoji}</span> {s.emoji === "🔥" ? "최장 연속 AI 활동 (🔥N) · 작은 숫자는 현재 · 점은 확인 중" : s.meaning}
              </span>
            ))}
          </div>
        </div>
        <Link href="/guide" className="inline-block font-medium text-[var(--accent-strong)]">
          전체 도감 →
        </Link>
      </div>
    </details>
  );
}
