import type { Types } from "mongoose";
import { connectDb, Device, type DeviceHealthEntry } from "@/lib/db";
import { anonymizeMachineId } from "@/lib/machine-id";
import {
  backupIncomingLegacyRows,
  deriveUploaderRows,
  sessionCoverage,
  upsertSessionRows,
} from "@/lib/sessions";
import type { DeviceInfo, IngestPayload, ParserHealth } from "@/lib/types";
import { registerIdentities, upsertHourlyRows, upsertUsageRows } from "@/lib/usage";

// Body of POST /api/ingest (the route only authenticates, parses JSON and
// validates with ingestPayloadSchema). Pure w.r.t. HTTP so it is testable
// against a disposable DB (src/scripts/verify-ingest-v2.ts).

export type IngestResult = {
  upserted: number; // v1 daily rows written to usagedailies
  skipped: number; // v1 daily rows NOT written: lower source priority, or diverted (R1)
  hourlyUpserted: number;
  sessionsUpserted: number;
  derived: { daily: number; hourly: number; divertedLegacy: number };
};

// v1-era uploaders (v1.1) send plan-limit snapshots as tool:"claude_limits"
// usage rows; those percentages must never enter usage totals (limits live in
// their own collection via /api/limits). Same rule for session rows.
const LIMITS_TOOL = "claude_limits";

// Parser health history (spec §3.3 compares against the previous 7 days).
// Uploads run hourly + on session end, so keeping every reading would cover
// hours, not days: sample at most one entry per parser per 12h, drop entries
// older than 7 days, cap at 14 per parser (2/day × 7 days).
const HISTORY_SAMPLE_MS = 12 * 3_600_000;
const HISTORY_WINDOW_MS = 7 * 86_400_000;
const HISTORY_MAX_PER_PARSER = 14;

// Latest-per-parser health is bounded too: readings older than 30 days are
// pruned on each write (a parser the uploader no longer runs), and at most 20
// distinct parsers are kept (most recent readings win).
const LATEST_WINDOW_MS = 30 * 86_400_000;
const LATEST_MAX_PARSERS = 20;

type Member = { _id: Types.ObjectId | string; email: string };

export async function handleIngest(
  member: Member,
  payload: IngestPayload,
  opts: { now?: Date } = {},
): Promise<IngestResult> {
  const result = await ingestUsage(member, payload);
  // Device AFTER the usage writes succeeded: lastSeenAt means "this machine's
  // upload landed", so a failed usage write (throws → 500, uploader retries)
  // must not advance it. A device-only heartbeat (R12) has no usage writes
  // and is recorded right away.
  if (payload.device) {
    await recordDevice(member.email, payload.device, payload.health ?? [], opts.now ?? new Date());
  }
  return result;
}

async function ingestUsage(member: Member, payload: IngestPayload): Promise<IngestResult> {
  const externalId = member.email;

  // Rows always belong to the authenticated member: externalId is forced to
  // their email (any caller-supplied value is ignored) so one member cannot
  // write or overwrite usage attributed to another. machineId goes through
  // the anonymization backstop (hostnames are never stored).
  const rows = (payload.rows ?? [])
    .filter((row) => row.tool !== LIMITS_TOOL)
    .map((row) => ({
      ...row,
      externalId,
      machineId: anonymizeMachineId(row.machineId ?? ""),
    }));
  // Session rows carry no externalId (schema strips it; upsertSessionRows
  // takes the member's). Anonymized here too — idempotent with the backstop
  // inside upsertSessionRows.
  const sessions = (payload.sessions ?? [])
    .filter((s) => s.tool !== LIMITS_TOOL)
    .map((s) => ({ ...s, machineId: anonymizeMachineId((s.machineId ?? "").trim()) }));

  const result: IngestResult = {
    upserted: 0,
    skipped: 0,
    hourlyUpserted: 0,
    sessionsUpserted: 0,
    derived: { daily: 0, hourly: 0, divertedLegacy: 0 },
  };
  // v1 behaviour kept: nothing usable → no usage writes at all (hourly
  // included). A device-only heartbeat (Ruling R12) ends here too; the caller
  // then records the device.
  if (rows.length === 0 && sessions.length === 0) return result;

  await connectDb();
  await registerIdentities(
    [...new Set([...rows.map((r) => r.tool), ...sessions.map((s) => s.tool)])].map((tool) => ({
      memberId: String(member._id),
      tool,
      externalId,
    })),
  );

  // Sessions before v1 rows, so the coverage check below sees this request's
  // sessions as well as earlier ones.
  if (sessions.length > 0) {
    const { upserted, touched } = await upsertSessionRows(externalId, sessions);
    result.sessionsUpserted = upserted;
    result.derived = await deriveUploaderRows(externalId, touched);
  }

  // Ruling R1: v1 uploader rows for a session-covered (tool, date) never
  // enter usagedailies (backup only); their hourly rows are dropped. With no
  // session coverage (every old-uploader-only member) this is a no-op and the
  // v1 path below runs exactly as before.
  const hourlyIn = (payload.hourly ?? []).map((row) => ({
    ...row,
    externalId,
    machineId: anonymizeMachineId(row.machineId ?? ""),
  }));
  const covered = await sessionCoverage(externalId, [
    ...rows.filter((r) => r.source === "uploader").map((r) => ({ tool: r.tool, date: r.date })),
    ...hourlyIn
      .filter((h) => h.source === "uploader")
      .map((h) => ({ tool: h.tool, date: h.hour.slice(0, 10) })),
  ]);
  const isCovered = (source: string, tool: string, date: string) =>
    source === "uploader" && covered.has(`${tool}|${date}`);
  const diverted = rows.filter((r) => isCovered(r.source, r.tool, r.date));
  const v1Rows = rows.filter((r) => !isCovered(r.source, r.tool, r.date));
  const v1Hourly = hourlyIn.filter((h) => !isCovered(h.source, h.tool, h.hour.slice(0, 10)));

  if (diverted.length > 0) {
    result.derived.divertedLegacy += await backupIncomingLegacyRows(diverted);
    result.skipped += diverted.length;
  }
  if (v1Rows.length > 0) {
    const { upserted, skipped } = await upsertUsageRows(v1Rows);
    result.upserted += upserted;
    result.skipped += skipped;
  }
  // Optional hour-grained rows (heatmap only). v1 processed them only when
  // daily rows were present; a payload whose rows were all claude_limits
  // returned above.
  if (v1Hourly.length > 0) {
    ({ upserted: result.hourlyUpserted } = await upsertHourlyRows(v1Hourly));
  }
  return result;
}

function toEntry(h: ParserHealth, at: Date): DeviceHealthEntry {
  return {
    parser: h.parser,
    filesScanned: h.filesScanned,
    linesUnrecognized: h.linesUnrecognized,
    sessionsEmitted: h.sessionsEmitted,
    error: h.error ?? null,
    at,
  };
}

// Upsert the (member, device) doc: label/version/lastSeenAt from this upload.
// LABEL SOURCE = the uploader config only (`deviceLabel` / --device-label):
// every upload overwrites it, and an upload without one clears it. A future
// web label editor must change this (e.g. a member-set label that uploads no
// longer overwrite) — otherwise the next hourly upload reverts the edit.
// latest health per reported parser (unreported parsers keep theirs), and the
// sampled history. Read-modify-write: two concurrent uploads from the SAME
// device may drop one health sample — harmless for a baseline.
async function recordDevice(
  externalId: string,
  device: DeviceInfo,
  health: ParserHealth[],
  now: Date,
): Promise<void> {
  await connectDb();
  const machineId = anonymizeMachineId(device.machineId);
  const label = device.label && device.label !== "" ? device.label : null;
  const existing = await Device.findOne({ externalId, machineId })
    .select({ health: 1, healthHistory: 1 })
    .lean();

  // Last reading per parser within this payload.
  const incoming = new Map<string, DeviceHealthEntry>();
  for (const h of health) incoming.set(h.parser, toEntry(h, now));

  const latest = new Map((existing?.health ?? []).map((h) => [h.parser, h]));
  for (const [parser, e] of incoming) latest.set(parser, e);
  const latestCutoff = now.getTime() - LATEST_WINDOW_MS;
  const latestHealth = [...latest.values()]
    .filter((h) => h.at.getTime() >= latestCutoff)
    .sort((a, b) => b.at.getTime() - a.at.getTime() || a.parser.localeCompare(b.parser))
    .slice(0, LATEST_MAX_PARSERS)
    .sort((a, b) => a.parser.localeCompare(b.parser));

  const cutoff = now.getTime() - HISTORY_WINDOW_MS;
  const history = (existing?.healthHistory ?? []).filter((h) => h.at.getTime() >= cutoff);
  for (const [parser, e] of incoming) {
    const lastAt = Math.max(
      -Infinity,
      ...history.filter((h) => h.parser === parser).map((h) => h.at.getTime()),
    );
    if (now.getTime() - lastAt >= HISTORY_SAMPLE_MS) history.push(e);
  }
  history.sort((a, b) => a.at.getTime() - b.at.getTime());
  const perParser = new Map<string, DeviceHealthEntry[]>();
  for (const h of history) perParser.set(h.parser, [...(perParser.get(h.parser) ?? []), h]);
  // History only for parsers still in the latest set, so it is bounded by
  // LATEST_MAX_PARSERS × HISTORY_MAX_PER_PARSER too.
  const kept = new Set(latestHealth.map((h) => h.parser));
  const healthHistory = [...perParser.entries()]
    .filter(([parser]) => kept.has(parser))
    .map(([, list]) => list)
    .flatMap((list) => list.slice(-HISTORY_MAX_PER_PARSER))
    .sort((a, b) => a.at.getTime() - b.at.getTime());

  await Device.updateOne(
    { externalId, machineId },
    {
      $set: {
        label,
        uploaderVersion: device.uploaderVersion,
        lastSeenAt: now,
        health: latestHealth,
        healthHistory,
      },
    },
    { upsert: true },
  );
}
