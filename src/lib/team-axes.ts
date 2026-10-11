// 팀 지표 — GP와 같은 세 축(자주·많이·다양하게)을 주 단위 중간값으로 본다.
// 단계 이름이나 종합 점수로 합치지 않고 세 숫자를 나란히 둔다.
import { addDays } from "@/lib/date";
import { volumeStep, type GrowthDay } from "@/lib/growth";

export type TeamAxesWeek = {
  week: string; // 그 주 월요일 (YYYY-MM-DD)
  // 센 날 수(0~7): 오늘까지 지났고 "확인 중"이 아닌 날. 자주 축의 분모.
  countedDays: number;
  complete: boolean; // 7일이 모두 세어진 주
  members: number;
  activeMembers: number; // 그 주에 하루라도 활동한 사람
  frequency: number | null; // 사람별 활동일 수의 중간값 (활동 없는 사람은 0일로 포함)
  volume: number | null; // 활동한 사람별 "활동일 사용량 단계(0~5) 중간값"의 중간값
  diversity: number | null; // 활동한 사람별 주간 모델 계열 수의 중간값
};

export function mondayOf(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// memberDays: 구성원 한 명당 GrowthDay 배열(활동한 날만 들어 있다).
// from이 속한 주의 월요일부터 today가 속한 주까지, 오래된 주 먼저.
export function teamAxesWeekly(
  memberDays: GrowthDay[][],
  opts: { from: string; today: string; unconfirmed?: ReadonlySet<string> },
): TeamAxesWeek[] {
  const byMember = memberDays.map((days) => new Map(days.map((d) => [d.date, d])));
  const weeks: TeamAxesWeek[] = [];
  for (let week = mondayOf(opts.from); week <= opts.today; week = addDays(week, 7)) {
    const dates: string[] = [];
    for (let i = 0; i < 7; i++) {
      const date = addDays(week, i);
      if (date <= opts.today && !opts.unconfirmed?.has(date)) dates.push(date);
    }
    const counts: number[] = [];
    const steps: number[] = [];
    const families: number[] = [];
    for (const days of byMember) {
      const active = dates.map((date) => days.get(date)).filter((d): d is GrowthDay => d !== undefined);
      counts.push(active.length);
      if (active.length === 0) continue;
      steps.push(median(active.map(volumeStep))!);
      families.push(new Set(active.flatMap((d) => d.families ?? [])).size);
    }
    const counted = dates.length > 0;
    weeks.push({
      week,
      countedDays: dates.length,
      complete: dates.length === 7,
      members: byMember.length,
      activeMembers: steps.length,
      frequency: counted ? median(counts) : null,
      volume: counted ? median(steps) : null,
      diversity: counted ? median(families) : null,
    });
  }
  return weeks;
}
