import { PageHeader, Card } from "@/app/_components/ui";
import { STAGE_LEGEND, milestoneGroups, STATE_LEGEND } from "@/lib/forest-symbols";
import { STREAK_CATALOG } from "@/lib/growth";

// 숲 기호·성장 규칙 전체 참조. 정적 데이터라 동적 마킹 불필요.
export default function GuidePage() {
  const groups = milestoneGroups();
  const streak = [...STREAK_CATALOG].sort((a, b) => a.days - b.days);
  const chip = "rounded-full bg-[var(--surface-2)] px-2.5 py-1 text-sm";
  return (
    <div>
      <PageHeader title="도감" />
      <p className="-mt-4 mb-6 text-xs text-[var(--text-muted)]">숲에 뜨는 기호와 성장 규칙 안내</p>
      <div className="space-y-4">
        <Card title="나무 단계">
          <div className="flex flex-wrap gap-2">
            {STAGE_LEGEND.map((s) => (
              <span key={s.label} className={chip}>
                {s.emoji} {s.label}
                {s.threshold !== undefined ? ` · ${s.threshold} GP 이상` : " · 활동 전"}
              </span>
            ))}
          </div>
        </Card>

        <Card title="마일스톤">
          <div className="space-y-3">
            {groups.map((g) => (
              <div key={g.axis}>
                <div className="text-sm font-semibold text-[var(--text-primary)]">
                  {g.axisLabel}{" "}
                  <span className="font-normal text-[var(--text-muted)]">— {g.meaning}</span>
                </div>
                <div className="mt-1 flex flex-wrap gap-2">
                  {g.tiers.map((t) => (
                    <span key={t.emoji} className={chip}>
                      {t.emoji} {t.label}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </Card>

        <Card title="상태">
          <div className="space-y-1 text-sm text-[var(--text-secondary)]">
            {STATE_LEGEND.map((s) => (
              <div key={s.emoji}>
                {s.emoji} <b className="text-[var(--text-primary)]">{s.label}</b> — {s.meaning}
              </div>
            ))}
            <div>
              🌳 <b className="text-[var(--text-primary)]">활력</b> — 오늘 활동한 나무는 밝고 경쾌하게,
              3일+ 쉬면 흐릿하게 조는다.
            </div>
          </div>
        </Card>

        <Card title="성장 규칙">
          <div className="space-y-2 text-sm text-[var(--text-secondary)]">
            <p>
              활동한 날마다 <b className="text-[var(--text-primary)]">10 GP × 스트릭 배수 + 효율 보너스</b>
              (최대 +5)가 쌓인다.
            </p>
            <div className="flex flex-wrap gap-1.5">
              {streak.map((s) => (
                <span key={s.days} className="rounded-full bg-[var(--surface-2)] px-2 py-0.5 text-xs">
                  {s.days}일 ×{s.mult}
                </span>
              ))}
            </div>
            <p>
              효율 보너스 = <b className="text-[var(--text-primary)]">컨텍스트 수율</b>(산출 ÷ 새로 끌어온
              컨텍스트) 밴드 + 도구 다양성. 주 1회 휴식은 스트릭이 유지된다.
            </p>
            <p>
              스트릭이 끊겨도 <b className="text-[var(--text-primary)]">🟠 불씨</b>로 남는다. 유예창
              <b className="text-[var(--text-primary)]"> 2 영업일</b> 안에 돌아오면 되살아난다 — 주말 끊김은
              <b className="text-[var(--text-primary)]"> 월요일 한 번</b>이면 자동 연결(주말 페널티 없음),
              그 외엔 자격 활동 2일. 성취로 모은 <b className="text-[var(--text-primary)]">🎟️ 복구 토큰</b>
              (최대 2)은 못 돌아온 스트릭을 자동으로 되살린다.
            </p>
            <p className="font-semibold text-[var(--accent-strong)]">
              토큰을 많이 쓴다고 나무가 크지 않는다 — 꾸준함과 효율만 반영된다.
            </p>
          </div>
        </Card>
      </div>
    </div>
  );
}
