// Unit tests for the gemini parser's pure core (foldSession). Run with node.
import { foldSession, assembleRows } from "../parsers/gemini.mjs";

let pass = 0, fail = 0;
function check(label, cond) {
  if (cond) { pass++; } else { fail++; console.error(`FAIL: ${label}`); }
}
function eq(label, a, b) { check(`${label} (got ${JSON.stringify(a)})`, JSON.stringify(a) === JSON.stringify(b)); }

// helper: build a gemini turn with CUMULATIVE token totals
const g = (ts, id, model, input, cached, output, thoughts) => ({
  id,
  timestamp: ts,
  type: "gemini",
  model,
  tokens: { input, output, cached, thoughts, tool: 0, total: input + output + thoughts },
});

// 1. Two cumulative turns (distinct ids): diffs attributed, input excludes
// cached, thoughts folded into output.
{
  const ev = foldSession([
    g("2026-06-26T02:00:00Z", "a", "gemini-3.5-flash", 100, 0, 10, 5),
    g("2026-06-26T02:05:00Z", "b", "gemini-3.5-flash", 250, 50, 30, 15),
  ]);
  eq("two turns -> 2 events", ev.length, 2);
  eq("e1 input", ev[0].inputTokens, 100);
  eq("e1 cacheRead", ev[0].cacheReadTokens, 0);
  eq("e1 output (incl thoughts)", ev[0].outputTokens, 15);
  eq("e1 model", ev[0].model, "gemini-3.5-flash");
  eq("e1 date", ev[0].date, "2026-06-26");
  // delta in=150, cached=50 -> input=100, cacheRead=50; output (30-10)+(15-5)=30
  eq("e2 input (excl cached)", ev[1].inputTokens, 100);
  eq("e2 cacheRead", ev[1].cacheReadTokens, 50);
  eq("e2 output (incl thoughts)", ev[1].outputTokens, 30);
}

// 2. Echoed duplicate id (streaming + final) is counted once.
{
  const ev = foldSession([
    g("2026-06-26T02:00:00Z", "a", "gemini-3.5-flash", 100, 0, 10, 0),
    g("2026-06-26T02:00:00Z", "a", "gemini-3.5-flash", 100, 0, 10, 0),
  ]);
  eq("duplicate id -> 1 event", ev.length, 1);
}

// 3. Reset (total drops) starts a fresh baseline and counts the full new total.
{
  const ev = foldSession([
    g("2026-06-26T02:00:00Z", "a", "gemini-3.5-flash", 200, 0, 20, 0),
    g("2026-06-26T03:00:00Z", "b", "gemini-3.5-flash", 50, 0, 5, 0),
  ]);
  eq("reset -> 2 events", ev.length, 2);
  eq("reset e2 input full", ev[1].inputTokens, 50);
}

// 4. thoughts-only turn still counts (output can be 0 while thoughts > 0).
{
  const ev = foldSession([
    g("2026-06-26T02:00:00Z", "a", "gemini-3.5-flash", 10, 0, 0, 7),
  ]);
  eq("thoughts-only -> 1 event", ev.length, 1);
  eq("thoughts-only output", ev[0].outputTokens, 7);
}

// 5. Model switch mid-session attributes the later delta to the new model.
{
  const ev = foldSession([
    g("2026-06-26T02:00:00Z", "a", "gemini-3.5-flash", 100, 0, 10, 0),
    g("2026-06-26T02:05:00Z", "b", "gemini-3.0-pro", 180, 0, 25, 0),
  ]);
  eq("e2 model switched", ev[1].model, "gemini-3.0-pro");
}

// 6. KST day boundary: 15:00Z + 9h crosses to next KST day.
{
  const ev = foldSession([
    g("2026-06-26T15:00:00Z", "a", "gemini-3.5-flash", 100, 0, 10, 0),
  ]);
  eq("KST boundary date", ev[0].date, "2026-06-27");
  eq("KST hour", ev[0].hour, "2026-06-27T00");
}

// 7. Entry without tokens is ignored (user turns, tool results).
{
  const ev = foldSession([
    { id: "u", timestamp: "2026-06-26T02:00:00Z", type: "user", content: "hi" },
    g("2026-06-26T02:05:00Z", "a", "gemini-3.5-flash", 100, 0, 10, 0),
  ]);
  eq("non-token entry skipped -> 1 event", ev.length, 1);
}

// assembleRows: merge per-file event lists, tool = gemini.
{
  const fileA = [
    { date: "2026-06-26", hour: "2026-06-26T02", model: "gemini-3.5-flash",
      inputTokens: 100, cacheReadTokens: 0, outputTokens: 15, cacheCreationTokens: 0 },
    { date: "2026-06-26", hour: "2026-06-26T02", model: "gemini-3.5-flash",
      inputTokens: 50, cacheReadTokens: 20, outputTokens: 5, cacheCreationTokens: 0 },
  ];
  const fileB = [
    { date: "2026-06-26", hour: "2026-06-26T09", model: "gemini-3.5-flash",
      inputTokens: 30, cacheReadTokens: 0, outputTokens: 3, cacheCreationTokens: 0 },
  ];
  const { rows, hourlyRows } = assembleRows([fileA, fileB], "test-host");

  eq("one daily row (same date|model)", rows.length, 1);
  eq("row tool", rows[0].tool, "gemini");
  eq("row input summed", rows[0].inputTokens, 180);
  eq("row cacheRead summed", rows[0].cacheReadTokens, 20);
  eq("row output summed", rows[0].outputTokens, 23);
  eq("row requests = events", rows[0].requests, 3);
  eq("row source", rows[0].source, "uploader");
  eq("sessions = distinct files that day", rows[0].sessions, 2);
  eq("two hourly rows", hourlyRows.length, 2);
}

console.log(fail === 0 ? `ALL PASS (${pass})` : `FAILED ${fail}/${pass + fail}`);
process.exit(fail === 0 ? 0 : 1);
