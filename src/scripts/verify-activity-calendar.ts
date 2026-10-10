import assert from "node:assert/strict";
import { buildActivityCalendar, activityDate, activityBadgeDescription, type ActivityEvidence } from "@/lib/activity-calendar";
const members = [{ id: "a", name: "A" }, { id: "b", name: "B" }];
const row = (date: string, extra: Partial<ActivityEvidence> = {}): ActivityEvidence => ({ memberId: "a", date, tool: "codex", source: "uploader", dateBasis: "KST", positive: true, ...extra });
const person = (rows: ActivityEvidence[], today = "2026-10-09") => buildActivityCalendar(members, rows, today).people[0];
let checks = 0;
function check(label: string, fn: () => void) { fn(); checks++; console.log(`PASS ${label}`); }
check("daily/model/device duplicates count once and preserve tools", () => {
  const p = person([row("2026-10-07"), row("2026-10-07"), row("2026-10-07", { tool: "claude_code" }), row("2026-10-08"), row("2026-10-09")]);
  assert.equal(p.days.length, 3); assert.equal(p.best.length, 3); assert.equal(p.current, 3);
  assert.deepEqual(p.days[0].tools, ["codex", "claude_code"]); assert.deepEqual(p.days[2].achievements, [3]);
});
check("month/year boundaries do not reset the streak", () => {
  const p = person([row("2025-12-30"), row("2025-12-31"), row("2026-01-01"), row("2026-01-02")], "2026-01-02");
  assert.deepEqual(p.best, { length: 4, from: "2025-12-30", to: "2026-01-02" }); assert.equal(p.current, 4);
});
check("unconfirmed gap is never bridged by grace or prior game history", () => {
  const p = person([row("2026-10-06"), row("2026-10-08"), row("2026-10-09")]);
  assert.equal(p.best.length, 2); assert.equal(p.current, 2); assert(!("gp" in p));
});
check("unconfirmed today anchors yesterday, unknown yesterday stays null", () => {
  const p = person([row("2026-10-06"), row("2026-10-07"), row("2026-10-08")]);
  assert.equal(p.current, 3); assert.equal(p.currentThrough, "2026-10-08");
  assert.equal(person([row("2026-10-07")]).current, null);
});
check("late receipt fills original date and recalculates once", () => {
  const before = [row("2026-10-06"), row("2026-10-08"), row("2026-10-09")];
  assert.equal(person(before).best.length, 2); assert.equal(person([...before, row("2026-10-07")]).best.length, 4);
});
check("old record persists and equal-length ties choose earliest period", () => {
  const p = person([row("2026-09-01"), row("2026-09-02"), row("2026-10-01"), row("2026-10-02")]);
  assert.deepEqual(p.best, { length: 2, from: "2026-09-01", to: "2026-09-02" }); assert.equal(p.current, null);
});
check("UTC daily and unknown basis never count as Korean dates", () => {
  const p = person([row("2026-10-07", { dateBasis: "UTC" }), row("2026-10-08", { dateBasis: "미확인" })]);
  assert.equal(p.best.length, 0); assert.equal(p.current, null); assert(p.days.every(d => !d.active));
});
check("UTC hour converts across midnight while KST hour stays put", () => {
  assert.equal(activityDate(row("2026-10-08", { hour: "2026-10-08T15", dateBasis: "UTC" })), "2026-10-09");
  assert.equal(activityDate(row("2026-10-08", { hour: "2026-10-08T15" })), "2026-10-08");
});
check("bad dates, invalid hours, future and non-positive evidence do not count", () => {
  assert.equal(activityDate(row("2026-02-30")), null); assert.equal(activityDate(row("2026-10-08", { hour: "2026-10-08T99" })), null);
  assert.equal(person([row("2026-10-10"), row("2026-02-30"), row("2026-10-08", { positive: false })]).best.length, 0);
});
check("hidden/unlinked/non-roster identities never enter public output", () => {
  const result = buildActivityCalendar(members, [row("2026-10-09", { memberId: "hidden", tool: "secret-private-tool" })], "2026-10-09");
  assert(!JSON.stringify(result).includes("secret-private-tool")); assert.equal(result.people.length, 2);
});
check("confirmed tool counts even when another source is unconfirmed", () => {
  const p = person([row("2026-10-09"), row("2026-10-09", { tool: "cursor", dateBasis: "UTC" })]);
  assert.equal(p.current, 1); assert.equal(p.days[0].sources.length, 2);
});
check("achievement recorded only on first threshold, not every later run", () => {
  const p = person([row("2026-09-01"), row("2026-09-02"), row("2026-09-03"), row("2026-10-01"), row("2026-10-02"), row("2026-10-03")]);
  assert.equal(p.days.flatMap(d => d.achievements).length, 1); assert.deepEqual(p.days[2].achievements, [3]);
});
check("empty records and badge distinguish unknown from zero activity", () => {
  const p = person([]); assert.equal(p.current, null); assert.equal(p.recordFrom, null);
  assert.match(activityBadgeDescription(p), /確認中|확인 중/); assert(!activityBadgeDescription(p).includes("현재 0일"));
});
console.log(`${checks} activity calendar boundary checks passed`);
