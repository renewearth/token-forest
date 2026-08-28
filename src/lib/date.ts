const DAY_MS = 24 * 60 * 60 * 1000;

export function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * DAY_MS).toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

// 0=Sun .. 6=Sat (UTC). 성장 경계는 KST지만 요일 판정은 날짜 문자열만으로 충분하다.
export function weekday(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

// 주말(토·일) 여부.
export function isWeekend(date: string): boolean {
  const d = weekday(date);
  return d === 0 || d === 6;
}

// 공휴일/전사 휴무일 — 주말과 동일하게 rest로 취급(스트릭 브릿지 대상). 배포별로
// TOKEN_FOREST_HOLIDAYS(콤마 구분 YYYY-MM-DD)로 설정한다. 미설정이면 주말만 rest.
// 불확실한 음력 공휴일을 코드에 하드코딩하지 않고 각 팀의 실제 달력·전사 휴무를
// 넣게 하는 유지보수형 설계.
export const DEFAULT_HOLIDAYS: ReadonlySet<string> = new Set(
  (process.env.TOKEN_FOREST_HOLIDAYS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^\d{4}-\d{2}-\d{2}$/.test(s)),
);

// rest 여부 = 주말 또는 공휴일. holidays를 주입하면 테스트/커스텀 달력에 쓸 수 있다.
export function isRestDay(
  date: string,
  holidays: ReadonlySet<string> = DEFAULT_HOLIDAYS,
): boolean {
  return isWeekend(date) || holidays.has(date);
}

// `date`로부터 영업일(주말·공휴일 제외) n일 뒤. n=0이면 그대로 반환.
export function addBusinessDays(
  date: string,
  n: number,
  holidays: ReadonlySet<string> = DEFAULT_HOLIDAYS,
): string {
  let cur = date;
  let left = n;
  while (left > 0) {
    cur = addDays(cur, 1);
    if (!isRestDay(cur, holidays)) left--;
  }
  return cur;
}

export function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

// KST (Asia/Seoul, fixed +9, no DST) calendar date for an instant (epoch ms).
// Shifting the instant by +9h then reading the UTC date yields the KST date.
export function kstDate(ms: number): string {
  return new Date(ms + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

// Today's date in KST — the display/growth day boundary for a Korean team.
export function todayKst(): string {
  return kstDate(Date.now());
}

// Team-wide tracking epoch: the shared anchor for growth GP (everyone measured
// from the same day, not their personal onboarding). Mirrors sync.ts's
// first-run backfill floor.
export function teamEpoch(): string {
  return process.env.TOKEN_FOREST_BACKFILL_START || addDays(todayKst(), -30);
}
