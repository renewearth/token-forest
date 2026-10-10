import type { DeviceHealthEntry } from "@/lib/db";

// Parser breakage detection for one v2 device (spec §3.3): a CLI update that
// changes the log format makes a parser silently emit 0. Compared per parser
// against its own readings of the previous 7 days (Device.healthHistory,
// sampled by src/lib/ingest.ts). Pure — no DB.

const BASELINE_WINDOW_MS = 7 * 86_400_000;
// "급증" = unrecognized lines above 120% of the previous average (floor 1), and
// at least 5 of them (controller Ruling R15) — a few stray half-written lines
// on a clean baseline are normal, not a format change.
const UNRECOGNIZED_JUMP = 1.2;
const UNRECOGNIZED_MIN = 5;

export function parserWarningText(parser: string): string {
  return `${parser} 기록을 읽지 못하고 있어요 — 업로더 업데이트 필요할 수 있음`;
}

const avg = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;

// warnings: one line per parser whose latest reading trips a rule —
//   1. filesScanned >= previous 7-day average (and > 0) but sessionsEmitted 0
//   2. linesUnrecognized >= 5 and
//      linesUnrecognized / max(1, previous average linesUnrecognized) > 1.2
// No previous reading → no baseline → no warning.
// errors: "parser: error" for each latest reading the uploader skipped (the
// error string is already clipped at ingest).
// labelOf: display name for a parser (callers pass toolLabel; default raw).
export function deviceHealthNotes(
  health: DeviceHealthEntry[],
  history: DeviceHealthEntry[],
  labelOf: (parser: string) => string = (p) => p,
): { warnings: string[]; errors: string[] } {
  const warnings: string[] = [];
  const errors: string[] = [];
  for (const latest of health) {
    if (latest.error) errors.push(`${labelOf(latest.parser)}: ${latest.error}`);
    const at = new Date(latest.at).getTime();
    const prev = history.filter((h) => {
      const t = new Date(h.at).getTime();
      return h.parser === latest.parser && t < at && t >= at - BASELINE_WINDOW_MS;
    });
    if (prev.length === 0) continue;
    const avgFiles = avg(prev.map((h) => h.filesScanned));
    const avgUnrecognized = avg(prev.map((h) => h.linesUnrecognized));
    const silentZero =
      latest.filesScanned > 0 && latest.filesScanned >= avgFiles && latest.sessionsEmitted === 0;
    const unrecognizedJump =
      latest.linesUnrecognized >= UNRECOGNIZED_MIN &&
      latest.linesUnrecognized / Math.max(1, avgUnrecognized) > UNRECOGNIZED_JUMP;
    if (silentZero || unrecognizedJump) {
      warnings.push(parserWarningText(labelOf(latest.parser)));
    }
  }
  return { warnings, errors };
}
