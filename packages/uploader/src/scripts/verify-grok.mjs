// Unit tests for the grok parser's pure core (assembleRows). Run with node.
import { assembleRows } from "../parsers/grok.mjs";

let pass = 0, fail = 0;
function check(label, cond) {
  if (cond) { pass++; } else { fail++; console.error(`FAIL: ${label}`); }
}
function eq(label, a, b) { check(`${label} (got ${JSON.stringify(a)})`, JSON.stringify(a) === JSON.stringify(b)); }

// one log line = one API call (per-call, not cumulative). ts = epoch seconds.
const line = (ts, model, pt, ct) => ({
  ts, tool: "chat", model, prompt_tokens: pt, completion_tokens: ct,
  total_tokens: pt + ct, cost_in_usd_ticks: 0,
});

// 1786636800 = 2026-08-14T00:00:00Z -> KST +9h = 2026-08-14T09 (same day).
const T = 1786636800;

// 1. Per-call lines sum into a daily row; prompt->input, completion->output.
{
  const { rows } = assembleRows([line(T, "grok-4-fast", 100, 10), line(T + 60, "grok-4-fast", 50, 5)]);
  eq("one daily row (same date|model)", rows.length, 1);
  eq("tool", rows[0].tool, "grok");
  eq("input = sum prompt_tokens", rows[0].inputTokens, 150);
  eq("output = sum completion_tokens", rows[0].outputTokens, 15);
  eq("no cache metric", rows[0].cacheReadTokens, 0);
  eq("requests = call count", rows[0].requests, 2);
  eq("sessions unknown -> null", rows[0].sessions, null);
  eq("source", rows[0].source, "uploader");
}

// 2. epoch SECONDS are scaled to ms (10-digit ts, not treated as ms).
{
  const { rows } = assembleRows([line(T, "grok-4-fast", 10, 1)]);
  eq("epoch-seconds date", rows[0].date, "2026-08-14");
}

// 3. Two models same day -> two rows.
{
  const { rows } = assembleRows([line(T, "grok-4-fast", 10, 1), line(T, "grok-3", 20, 2)]);
  eq("two models -> 2 rows", rows.length, 2);
}

// 4. KST day boundary: 15:00Z + 9h crosses to next KST day.
{
  const midZ = 1786633200; // 2026-08-13T23:00:00Z -> KST 2026-08-14T08
  const { rows } = assembleRows([line(midZ, "grok-4-fast", 10, 1)]);
  eq("KST rollover date", rows[0].date, "2026-08-14");
}

// 5. sinceDate filter drops older lines.
{
  const older = 1786550400; // 2026-08-13T00:00:00Z -> KST 2026-08-13T09
  const { rows } = assembleRows([line(older, "grok-4-fast", 10, 1), line(T, "grok-4-fast", 20, 2)], "", "2026-08-14");
  eq("since filter -> 1 row", rows.length, 1);
  eq("since filter keeps newer", rows[0].date, "2026-08-14");
}

// 6. Zero-token line contributes nothing.
{
  const { rows } = assembleRows([line(T, "grok-4-fast", 0, 0)]);
  eq("zero-token line -> no row", rows.length, 0);
}

// 7. Hourly mirror keeps hours distinct.
{
  const { hourlyRows } = assembleRows([line(T, "grok-4-fast", 10, 1), line(T + 3600, "grok-4-fast", 20, 2)]);
  eq("two hourly rows", hourlyRows.length, 2);
}

console.log(fail === 0 ? `ALL PASS (${pass})` : `FAILED ${fail}/${pass + fail}`);
process.exit(fail === 0 ? 0 : 1);
