import { connectDb, Member, VISIBLE_MEMBER } from "@/lib/db";
import { addDays, todayKst } from "@/lib/date";
import { GP_RULES } from "@/lib/growth";
import { getGrowthDays, getModelAdoption, getUnconfirmedGrowthDates } from "@/lib/queries";
import { adoptionLeadDays } from "@/lib/scorecard";
import { mondayOf, teamAxesWeekly, type TeamAxesWeek } from "@/lib/team-axes";
import { formatCompact } from "@/app/_lib/ui";
import { Card, EmptyState } from "./ui";

const WEEKS = 8;
const fmt = (v: number | null) => (v == null ? "—" : Number.isInteger(v) ? String(v) : v.toFixed(1));

function delta(now: number | null, before: number | null): string {
  if (now == null || before == null) return "직전 주와 비교 불가";
  const diff = now - before;
  if (diff === 0) return "직전 주와 같음";
  return `직전 주보다 ${fmt(Math.abs(diff))} ${diff > 0 ? "늘어남" : "줄어듦"}`;
}

// 팀 지표: 성장 점수(GP)와 같은 재료·같은 기준을 주 단위 중간값으로 보여준다.
export default async function TeamAxes() {
  await connectDb();
  const today = todayKst();
  const from = addDays(mondayOf(today), -7 * (WEEKS - 1));
  const [members, unconfirmed, adoption] = await Promise.all([
    Member.find(VISIBLE_MEMBER, { _id: 1 }).lean(),
    getUnconfirmedGrowthDates(today),
    getModelAdoption(120),
  ]);
  if (members.length === 0) return null;
  const memberDays = await Promise.all(members.map((m) => getGrowthDays(String(m._id), from)));
  const weeks = teamAxesWeekly(memberDays, { from, today, unconfirmed });
  const complete = weeks.filter((w) => w.complete);
  const latest: TeamAxesWeek | undefined = complete.at(-1);
  const before = complete.at(-2);
  const current = weeks.at(-1);
  const spread = adoption
    .map((a) => ({ model: a.model, days: adoptionLeadDays(a.memberFirstDates, members.length) }))
    .find((a) => a.days != null);

  return (
    <Card title="팀 사용 세 축" hint="성장 점수(GP)와 같은 기준 · 구성원별 값의 주간 중간값">
      {latest ? (
        <>
          <p className="mb-3 text-xs text-[var(--text-muted)]">
            {latest.week} ~ {addDays(latest.week, 6)} 주 · 구성원 {latest.members}명 중 {latest.activeMembers}명 활동
          </p>
          <dl className="grid grid-cols-1 gap-4 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-[var(--text-muted)]">자주</dt>
              <dd className="mt-1 text-lg font-semibold tabular-nums">주 {fmt(latest.frequency)}일</dd>
              <dd className="mt-1 text-xs">한 사람이 일주일에 AI를 쓴 날 수 · {delta(latest.frequency, before?.frequency ?? null)}</dd>
            </div>
            <div>
              <dt className="text-[var(--text-muted)]">많이</dt>
              <dd className="mt-1 text-lg font-semibold tabular-nums">{fmt(latest.volume)}단계 <span className="text-xs font-normal text-[var(--text-muted)]">/ {GP_RULES.tokenSteps.length}</span></dd>
              <dd className="mt-1 text-xs">쓴 날 하루 사용량이 닿은 단계 · {delta(latest.volume, before?.volume ?? null)}</dd>
            </div>
            <div>
              <dt className="text-[var(--text-muted)]">다양하게</dt>
              <dd className="mt-1 text-lg font-semibold tabular-nums">모델 계열 {fmt(latest.diversity)}종</dd>
              <dd className="mt-1 text-xs">한 사람이 일주일에 쓴 모델 계열 수 · {delta(latest.diversity, before?.diversity ?? null)}</dd>
              {spread && <dd className="mt-1 text-xs">새 모델 {spread.model}: 팀 절반이 쓰기까지 {spread.days}일</dd>}
            </div>
          </dl>
        </>
      ) : (
        <EmptyState message="7일이 모두 확인된 주가 아직 없습니다." />
      )}
      {current && !current.complete && (
        <p className="mt-3 text-xs text-[var(--text-muted)]">
          이번 주(진행 중, 확인된 {current.countedDays}일 기준): 자주 {fmt(current.frequency)}일 · 많이 {fmt(current.volume)}단계 · 다양하게 {fmt(current.diversity)}종
        </p>
      )}
      <details className="mt-3 text-xs">
        <summary className="cursor-pointer">최근 {WEEKS}주 표와 단계 기준 보기</summary>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full text-left tabular-nums">
            <thead><tr><th>주 시작</th><th>센 날</th><th>활동 인원</th><th>자주(일)</th><th>많이(단계)</th><th>다양하게(종)</th></tr></thead>
            <tbody>
              {weeks.map((w) => (
                <tr key={w.week}>
                  <td>{w.week}</td><td>{w.countedDays}일</td><td>{w.activeMembers}/{w.members}</td>
                  <td>{fmt(w.frequency)}</td><td>{fmt(w.volume)}</td><td>{fmt(w.diversity)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-[var(--text-muted)]">
          사용량 단계: 하루 환산 토큰 {GP_RULES.tokenSteps.map((v) => formatCompact(v)).join(" · ")} 또는 요청 {GP_RULES.requestSteps.join(" · ")}건을 넘을 때마다 한 단계 (둘 중 높은 쪽).
          모델 계열은 그날 사용량의 10% 이상을 차지한 계열만 셉니다. 보고서가 아직 오지 않은 날은 세지 않습니다. 자주는 활동이 없던 구성원을 0일로 포함하고, 많이·다양하게는 그 주에 활동한 구성원만 봅니다.
        </p>
      </details>
    </Card>
  );
}
