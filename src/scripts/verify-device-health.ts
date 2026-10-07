// Parser health warnings (collection v2 Task 6, spec §3.3) — pure, no DB:
//   ./node_modules/.bin/tsx src/scripts/verify-device-health.ts
import type { DeviceHealthEntry } from "@/lib/db";
import { deviceHealthNotes, parserWarningText } from "@/lib/device-health";

let pass = 0;
let fail = 0;
function check(label: string, cond: boolean, detail?: unknown) {
  if (cond) {
    pass++;
  } else {
    fail++;
    console.error(`FAIL: ${label}`, detail === undefined ? "" : JSON.stringify(detail));
  }
}
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const HOUR = 3_600_000;
const NOW = new Date("2026-09-30T03:00:00Z");
const ago = (h: number) => new Date(NOW.getTime() - h * HOUR);

function entry(
  parser: string,
  filesScanned: number,
  linesUnrecognized: number,
  sessionsEmitted: number,
  at: Date,
  error: string | null = null,
): DeviceHealthEntry {
  return { parser, filesScanned, linesUnrecognized, sessionsEmitted, error, at };
}

const W = (p: string) => parserWarningText(p);

// Text verbatim (parser name substituted for 〈parser〉).
check(
  "warning text verbatim",
  W("codex") === "codex 기록을 읽지 못하고 있어요 — 업로더 업데이트 필요할 수 있음",
  W("codex"),
);

// No baseline → nothing to compare against → no warning.
check(
  "no history → no warning",
  eq(deviceHealthNotes([entry("codex", 10, 0, 0, NOW)], []), { warnings: [], errors: [] }),
);
// The latest reading itself sits in healthHistory (ingest samples it) — it is
// not its own baseline.
{
  const latest = entry("codex", 10, 0, 0, NOW);
  check(
    "history holding only the latest reading → no baseline → no warning",
    eq(deviceHealthNotes([latest], [latest]).warnings, []),
  );
}

// Rule 1: filesScanned >= previous 7-day average but sessionsEmitted 0.
const baseline = [
  entry("codex", 8, 1, 5, ago(36)),
  entry("codex", 12, 1, 6, ago(24)),
  entry("codex", 10, 1, 4, ago(12)),
]; // avg files 10, avg unrecognized 1
check(
  "rule 1: files at average, 0 sessions → warn",
  eq(deviceHealthNotes([entry("codex", 10, 1, 0, NOW)], baseline).warnings, [W("codex")]),
);
check(
  "rule 1: files above average, 0 sessions → warn",
  eq(deviceHealthNotes([entry("codex", 30, 0, 0, NOW)], baseline).warnings, [W("codex")]),
);
check(
  "rule 1: files below average, 0 sessions → no warn (quiet period)",
  eq(deviceHealthNotes([entry("codex", 9, 0, 0, NOW)], baseline).warnings, []),
);
check(
  "rule 1: files at average, sessions > 0 → no warn",
  eq(deviceHealthNotes([entry("codex", 10, 1, 3, NOW)], baseline).warnings, []),
);
check(
  "rule 1: nothing scanned at all (0 files, avg 0) → no warn",
  eq(
    deviceHealthNotes(
      [entry("gemini", 0, 0, 0, NOW)],
      [entry("gemini", 0, 0, 0, ago(24))],
    ).warnings,
    [],
  ),
);

// Rule 2: linesUnrecognized / max(1, previous average) > 1.2 (a >20% jump).
check(
  "rule 2: unrecognized 1→2 (ratio 2 but under 5 lines, R15) → no warn",
  eq(deviceHealthNotes([entry("codex", 5, 2, 4, NOW)], baseline).warnings, []),
);
check(
  "rule 2: unrecognized 1→5 (ratio 5, 5 lines) → warn",
  eq(deviceHealthNotes([entry("codex", 5, 5, 4, NOW)], baseline).warnings, [W("codex")]),
);
check(
  "rule 2: unrecognized steady → no warn",
  eq(deviceHealthNotes([entry("codex", 5, 1, 4, NOW)], baseline).warnings, []),
);
{
  const base10 = [entry("grok", 3, 10, 2, ago(24)), entry("grok", 3, 10, 2, ago(12))];
  check(
    "rule 2: 10→12 (exactly +20%) → no warn",
    eq(deviceHealthNotes([entry("grok", 3, 12, 2, NOW)], base10).warnings, []),
  );
  check(
    "rule 2: 10→13 (+30%) → warn",
    eq(deviceHealthNotes([entry("grok", 3, 13, 2, NOW)], base10).warnings, [W("grok")]),
  );
}
{
  const base0 = [entry("grok", 3, 0, 2, ago(24))];
  check(
    "rule 2: baseline 0, one stray line (1/max(1,0)=1) → no warn",
    eq(deviceHealthNotes([entry("grok", 3, 1, 2, NOW)], base0).warnings, []),
  );
  check(
    "rule 2: baseline 0, two lines (under the 5-line minimum, R15) → no warn",
    eq(deviceHealthNotes([entry("grok", 3, 2, 2, NOW)], base0).warnings, []),
  );
  check(
    "rule 2: baseline 0, six lines → warn",
    eq(deviceHealthNotes([entry("grok", 3, 6, 2, NOW)], base0).warnings, [W("grok")]),
  );
}

// Both rules on one parser → one warning, not two.
check(
  "both rules → single warning",
  eq(deviceHealthNotes([entry("codex", 20, 9, 0, NOW)], baseline).warnings, [W("codex")]),
);

// Baseline window: only readings strictly before the latest one and within
// the 7 days before it.
{
  const old = [entry("codex", 10, 0, 5, ago(24 * 7 + 1))];
  check(
    "baseline older than 7 days before latest → ignored → no warn",
    eq(deviceHealthNotes([entry("codex", 10, 0, 0, NOW)], old).warnings, []),
  );
  const later = [entry("codex", 10, 0, 5, new Date(NOW.getTime() + HOUR))];
  check(
    "reading after the latest → not a baseline → no warn",
    eq(deviceHealthNotes([entry("codex", 10, 0, 0, NOW)], later).warnings, []),
  );
}

// Per parser: another parser's history is not mixed in; order follows health.
{
  const health = [entry("claude_code", 50, 0, 7, NOW), entry("codex", 10, 0, 0, NOW)];
  const history = [
    entry("claude_code", 50, 0, 7, ago(24)),
    ...baseline,
    entry("gemini", 100, 0, 0, ago(24)),
  ];
  check(
    "only the broken parser warns",
    eq(deviceHealthNotes(health, history).warnings, [W("codex")]),
    deviceHealthNotes(health, history),
  );
}

// health.error surfaces as a secondary line (already clipped at ingest), with
// or without a warning.
{
  const notes = deviceHealthNotes(
    [
      entry("opencode", 0, 0, 0, NOW, "database is locked"),
      entry("codex", 10, 1, 0, NOW),
    ],
    baseline,
  );
  check("error surfaced", eq(notes.errors, ["opencode: database is locked"]), notes);
  check("error does not suppress other warnings", eq(notes.warnings, [W("codex")]), notes);
}
// Display names: callers pass toolLabel; warning and error lines use it.
{
  const label = (p: string) => ({ codex: "Codex", opencode: "OpenCode" })[p] ?? p;
  const notes = deviceHealthNotes(
    [entry("codex", 10, 1, 0, NOW), entry("opencode", 0, 0, 0, NOW, "locked")],
    baseline,
    label,
  );
  check("labelOf applied to warning", eq(notes.warnings, [W("Codex")]), notes);
  check("labelOf applied to error", eq(notes.errors, ["OpenCode: locked"]), notes);
}
check(
  "no error → no error line",
  eq(deviceHealthNotes([entry("codex", 5, 1, 4, NOW)], baseline).errors, []),
);

console.log(`PASS=${pass} FAIL=${fail}`);
if (fail === 0) console.log("ALL PASS");
process.exit(fail === 0 ? 0 : 1);
