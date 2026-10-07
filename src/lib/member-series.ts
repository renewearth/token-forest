import { addDays, todayKst } from "@/lib/date";
import { emptyObservation, mergeObservations, type Observation } from "@/lib/observation";
export type MemberSeries = {
  data: Record<string, string | number | null>[];
  members: { key: string; name: string; total: number | null; unpricedTokens: number; observation: Observation }[];
  observations: Record<string, Record<string, Observation>>;
  observation: Observation;
};
export function buildMemberSeries(
  rows: { date: string; memberId: string; tokens: number; unpricedTokens: number; observation?: Observation }[],
  names: { id: string; name: string }[], range: { from: string; to: string },
): MemberSeries {
  const byId = new Map(names.map((m) => [m.id, m.name]));
  const counts = new Map<string, number>();
  for (const m of names) counts.set(m.name, (counts.get(m.name) ?? 0) + 1);
  const labels = new Map(names.map((m) => [`m${m.id}`, `${m.name}${(counts.get(m.name) ?? 0) > 1 ? ` · ${m.id}` : ""}`]));
  const cells = new Map<string, Observation[]>();
  const memberItems = new Map<string, Observation[]>();
  const all: Observation[] = [];
  for (const row of rows) {
    if (row.date < range.from || row.date > range.to) continue;
    const key = byId.has(row.memberId) ? `m${row.memberId}` : "other";
    if (key === "other") labels.set(key, "기타 집계");
    const o = row.observation ?? { ...emptyObservation(), value: row.tokens, status: "observed" as const, unpricedTokens: row.unpricedTokens };
    const cellKey = `${row.date}|${key}`;
    const cell = cells.get(cellKey) ?? []; cell.push(o); cells.set(cellKey, cell);
    const bucket = memberItems.get(key) ?? []; bucket.push(o); memberItems.set(key, bucket); all.push(o);
  }
  const members = [...labels].sort(([a], [b]) => a.localeCompare(b)).map(([key, name]) => {
    const observation = mergeObservations(memberItems.get(key) ?? []);
    return { key, name, total: observation.value, unpricedTokens: observation.unpricedTokens, observation };
  });
  const today = todayKst();
  const data: MemberSeries["data"] = [];
  const observations: MemberSeries["observations"] = {};
  for (let date = range.from; date <= range.to; date = addDays(date, 1)) {
    const day: MemberSeries["data"][number] = { date }; const states: Record<string, Observation> = {};
    for (const member of members) { const o = { ...mergeObservations(cells.get(`${date}|${member.key}`) ?? []), inProgress: date === today }; day[member.key] = o.value; states[member.key] = o; }
    states.__total = { ...mergeObservations(Object.values(states)), inProgress: date === today }; day.__total = states.__total.value;
    data.push(day); observations[date] = states;
  }
  return { data, members, observations, observation: { ...mergeObservations(all), inProgress: range.from <= today && range.to >= today } };
}
