import { connectDb, Member } from "@/lib/db";
import { getGrowthDays } from "@/lib/queries";
import { computeGrowth, MILESTONE_CATALOG, STAGE_CATALOG } from "@/lib/growth";
import { todayKst, teamEpoch } from "@/lib/date";
import { Card } from "@/app/_components/ui";
import Link from "next/link";

// 내 나무 카드: 스테이지·GP 게이지·스트릭·다음 마일스톤.
// growth 엔진 규칙(토큰량은 성장에 미기여)에 따라 볼륨 수치는 표시하지 않는다.
export default async function GrowthCard({ memberId }: { memberId: string }) {
  await connectDb();
  const member = await Member.findById(memberId).lean();
  if (!member) return null;
  const onboarded = member.onboardedAt
    ? new Date(member.onboardedAt).toISOString().slice(0, 10)
    : null;
  const days = await getGrowthDays(memberId, onboarded ?? "1970-01-01");
  const g = computeGrowth(days, teamEpoch(), todayKst());

  const total = g.gp + (g.toNextStage ?? 0);
  const pct =
    g.toNextStage == null
      ? 100
      : total === 0
        ? 0
        : Math.min(100, Math.round((g.gp / total) * 100));
  const fire =
    g.streakDays >= 3 ? `🔥${g.streakDays}` : g.idleDays >= 3 ? `💤${g.idleDays}` : null;
  const earned = new Set(g.milestones);
  const ember = g.ember;
  const emberHow =
    ember?.kind === "bridge"
      ? "영업일에 한 번만 활동하면 되살아나요"
      : `자격 활동 ${ember?.have ?? 0}/${ember?.needed ?? 0}일이면 되살아나요`;

  return (
    <Card title="내 나무">
      <div className="flex items-center gap-4">
        <div className="text-5xl leading-none">{g.stageEmoji}</div>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <h2 className="text-lg font-semibold text-[var(--text-primary)]">
              {g.stageLabel}
            </h2>
            <span className="text-sm text-[var(--text-secondary)]">Lv{g.level}</span>
            {fire && <span className="text-sm">{fire}</span>}
            {g.restoreTokens > 0 && (
              <span
                className="text-sm"
                title={`복구 토큰 ${g.restoreTokens}개 — 끊긴 스트릭을 자동으로 되살립니다`}
              >
                🎟️{g.restoreTokens}
              </span>
            )}
          </div>
          <div className="mt-2 h-2 overflow-hidden rounded-full bg-[var(--surface-2)]">
            <div
              className="h-full rounded-full bg-[var(--accent)]"
              style={{ width: `${pct}%` }}
            />
          </div>
          <div className="mt-1 text-xs text-[var(--text-muted)]">
            {g.gp} GP
            {g.toNextStage != null && ` · 다음 단계까지 ${g.toNextStage}`}
          </div>
        </div>
      </div>
      {ember && (
        <div className="mt-3 rounded-lg border border-[var(--accent-strong)] bg-[var(--surface-2)] px-3 py-2">
          <p className="text-sm font-semibold text-[var(--accent-strong)]">
            🟠 불씨가 남아 있어요 — 🔥{ember.length} 되살리기
          </p>
          <p className="mt-0.5 text-xs text-[var(--text-secondary)]">
            {emberHow} · <span className="font-medium">{ember.graceEndsAt}</span>까지
          </p>
        </div>
      )}
      {g.nextMilestone && (
        <p className="mt-3 rounded-lg bg-[var(--surface-2)] px-3 py-2 text-sm text-[var(--accent-strong)]">
          다음 마일스톤: {g.nextMilestone.label}까지 {g.nextMilestone.remaining}
        </p>
      )}
      <div className="mt-3 flex flex-wrap gap-1.5">
        {MILESTONE_CATALOG.map((m) => (
          <span
            key={m.key}
            title={`${m.label}${earned.has(m.key) ? " — 획득" : ""}`}
            className={`text-lg leading-none ${earned.has(m.key) ? "" : "opacity-30 grayscale"}`}
          >
            {m.emoji}
          </span>
        ))}
      </div>
      <p className="mt-2 text-xs text-[var(--text-secondary)]">
        활동 {g.activeDays}일 · 최고 🔥{g.bestStreak} · 오늘 효율 +{g.efficiencyBonusToday}
      </p>
      <Link href="/guide" className="mt-2 inline-block text-xs font-medium text-[var(--accent-strong)]">
        기호·규칙 전체 도감 →
      </Link>
      <details className="mt-3 text-xs text-[var(--text-secondary)]">
        <summary className="cursor-pointer select-none">성장 규칙</summary>
        <div className="mt-2 space-y-2">
          <div className="flex flex-wrap items-center gap-1">
            {STAGE_CATALOG.map((s) => (
              <span key={s.stage} className="rounded-full bg-[var(--surface-2)] px-2 py-0.5">
                {s.emoji} {s.label} {s.minGp}
              </span>
            ))}
          </div>
          <p>활동한 날마다 10 GP × 스트릭 배수 + 효율 보너스(캐시 적중·멀티툴, 최대 +5).</p>
          <p>주 1회 휴식은 스트릭이 유지됩니다. 끊겨도 <b>불씨</b>로 남아, 유예창(2 영업일) 안에
            돌아오면 되살아납니다 — 주말 뒤 월요일 한 번이면 자동 연결(주말은 페널티 없음).</p>
          <p className="font-semibold text-[var(--accent-strong)]">
            토큰을 많이 쓴다고 나무가 크지 않습니다 — 꾸준함과 효율만 반영됩니다.
          </p>
        </div>
      </details>
    </Card>
  );
}
