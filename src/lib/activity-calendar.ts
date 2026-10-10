import { addDays } from "@/lib/date";
import type { DateBasis } from "@/lib/observation";

export type ActivityEvidence = {
  memberId: string; date: string; hour?: string; tool: string;
  source: string; dateBasis: DateBasis; positive: boolean;
};
export type ActivitySource = {
  tool: string; source: string; dateBasis: DateBasis;
  grain: "day" | "hour"; confirmed: boolean;
};
export type ActivityDay = {
  date: string; active: boolean; tools: string[]; sources: ActivitySource[];
  achievements: number[];
};
export type ActivityPerson = {
  id: string; name: string; days: ActivityDay[]; recordFrom: string | null;
  best: { length: number; from: string | null; to: string | null };
  current: number | null; currentThrough: string | null;
};
export type ActivityCalendarData = { today: string; people: ActivityPerson[]; available: boolean };

export function validActivityDate(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const ms = Date.parse(`${date}T00:00:00Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === date;
}

// UTC DAILY buckets cannot be moved: they straddle two Korean dates. Only an
// explicitly based hourly bucket can be placed in a KST calendar accurately.
export function activityDate(row: ActivityEvidence): string | null {
  if (row.hour) {
    if (!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3])$/.test(row.hour) || !validActivityDate(row.hour.slice(0, 10))) return null;
    if (row.dateBasis === "KST") return row.hour.slice(0, 10);
    if (row.dateBasis === "UTC") return new Date(Date.parse(`${row.hour}:00:00Z`) + 9 * 3600000).toISOString().slice(0, 10);
    return null;
  }
  return row.dateBasis === "KST" && validActivityDate(row.date) ? row.date : null;
}

export function buildActivityCalendar(
  members: Array<{ id: string; name: string }>, rows: ActivityEvidence[], today: string,
): ActivityCalendarData {
  const buckets = new Map(members.map(m => [m.id, new Map<string, ActivityDay>()]));
  for (const row of rows) {
    const bucket = buckets.get(row.memberId);
    if (!bucket || !row.positive) continue;
    const confirmedDate = activityDate(row);
    const date = confirmedDate ?? (validActivityDate(row.date) ? row.date : null);
    if (!date || date > today) continue;
    const day = bucket.get(date) ?? { date, active: false, tools: [], sources: [], achievements: [] };
    if (confirmedDate) {
      day.active = true;
      if (!day.tools.includes(row.tool)) day.tools.push(row.tool);
    }
    const source: ActivitySource = { tool: row.tool, source: row.source, dateBasis: row.dateBasis, grain: row.hour ? "hour" : "day", confirmed: !!confirmedDate };
    if (!day.sources.some(s => JSON.stringify(s) === JSON.stringify(source))) day.sources.push(source);
    bucket.set(date, day);
  }
  const people = members.map(member => {
    const days = [...buckets.get(member.id)!.values()].sort((a, b) => a.date.localeCompare(b.date));
    const active = days.filter(d => d.active);
    const best: ActivityPerson["best"] = { length: 0, from: null, to: null };
    const achieved = new Set<number>();
    let length = 0, from: string | null = null, previous: string | null = null;
    for (const day of active) {
      length = previous && addDays(previous, 1) === day.date ? length + 1 : 1;
      if (length === 1) from = day.date;
      if (length > best.length) Object.assign(best, { length, from, to: day.date });
      if ([3, 7, 14, 30].includes(length) && !achieved.has(length)) {
        day.achievements.push(length); achieved.add(length);
      }
      previous = day.date;
    }
    const dates = new Set(active.map(d => d.date));
    const anchor = dates.has(today) ? today : dates.has(addDays(today, -1)) ? addDays(today, -1) : null;
    let current: number | null = null;
    if (anchor) {
      current = 0;
      for (let date = anchor; dates.has(date); date = addDays(date, -1)) current++;
    }
    // No source-scope coverage evidence exists yet. Missing/zero historical
    // rows cannot prove inactivity, so an unconfirmed tail remains null.
    return { ...member, days, best, current, currentThrough: anchor, recordFrom: days[0]?.date ?? null };
  });
  return { today, people, available: true };
}

export function activityBadgeDescription(person: ActivityPerson): string {
  const best = person.best.length ? `최장 연속 AI 활동 ${person.best.length}일 (${person.best.from} ~ ${person.best.to})` : "최장 연속 AI 활동 확인 중";
  const current = person.current === null ? "현재 연속 활동 확인 중" : `현재 ${person.current}일 (${person.currentThrough}까지 확인)`;
  return `${best} · ${current} · KST 날짜가 확인된 AI 사용 기록 · 자료 범위 ${person.recordFrom ?? "미확인"}부터`;
}
