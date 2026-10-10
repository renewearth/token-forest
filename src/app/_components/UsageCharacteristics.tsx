import { getScorecardSums, getAllMembers, getToolSummary } from "@/lib/queries";
import { EMPTY_SUMS, addSums, sessionDepth, cacheReuseRatio } from "@/lib/scorecard";
import { Card } from "./ui";
import { toolLabel } from "@/app/_lib/ui";

export default async function UsageCharacteristics({ range }: { range: { from: string; to: string } }) {
  const [rows, members, tools] = await Promise.all([getScorecardSums(range), getAllMembers(), getToolSummary(range)]);
  const supported = rows.filter(r => ["claude_code", "codex"].includes(r.tool));
  const claude = rows.filter(r => r.tool === "claude_code");
  const cache = cacheReuseRatio(supported.reduce((s, r) => addSums(s, r.sums), { ...EMPTY_SUMS }));
  const depth = sessionDepth(claude.reduce((s, r) => addSums(s, r.sums), { ...EMPTY_SUMS }));
  const fmt = (v: number | null) => v == null ? "집계 불가" : v.toFixed(1);
  return <Card title="사용 특성" hint="수집된 관찰 항목 · 종합 단계나 역량 평가가 아닙니다">
    <dl className="grid grid-cols-1 gap-4 text-sm sm:grid-cols-3">
      <div><dt className="text-[var(--text-muted)]">캐시 재사용 배율</dt><dd className="mt-1 font-medium">{fmt(cache)}</dd><dd className="mt-1 text-xs">캐시 읽기 ÷ 캐시 쓰기 · Claude Code·Codex의 수집 기록</dd></div>
      <div><dt className="text-[var(--text-muted)]">세션당 요청</dt><dd className="mt-1 font-medium">{fmt(depth)}</dd><dd className="mt-1 text-xs">Claude Code만 · 관측된 {new Set(claude.map(r => r.memberId)).size}명 / 등록 {members.length}명</dd></div>
      <div><dt className="text-[var(--text-muted)]">관측된 도구</dt><dd className="mt-1 break-words font-medium">{tools.map(t => toolLabel(t.tool)).join(" · ") || "집계 불가"}</dd><dd className="mt-1 text-xs">도구 수와 대화 길이에 목표값을 두지 않습니다.</dd></div>
    </dl>
  </Card>;
}
