import { Types } from "mongoose";
import {
  connectDb,
  LimitSnapshot,
  Member,
  MemberIdentity,
  SyncRun,
  UsageDaily,
  UsageHourly,
} from "@/lib/db";
import type { LimitSnapshotInput, UsageHourlyRow, UsageRow } from "@/lib/types";
import { canonicalizeModel } from "@/lib/models";

// Load the (tool, externalId) -> memberId mapping once; the identities
// collection is tiny relative to ingest batches.
async function identityMap(): Promise<Map<string, Types.ObjectId>> {
  const rows = await MemberIdentity.find().lean();
  return new Map(rows.map((r) => [`${r.tool} ${r.externalId}`, r.memberId]));
}

// The same account can be captured through more than one path (e.g. a central
// poller AND the local uploader for claude_code). Rows from different sources
// must never add up: for a logical key (date, tool, model, externalId) —
// machineId intentionally excluded — only the highest-priority source counts.
const SOURCE_PRIORITY: Record<string, number> = {
  poller: 2,
  uploader: 1,
  manual: 0,
};

function logicalKey(row: {
  date: string;
  tool: string;
  model?: string | null;
  externalId: string;
}): string {
  return JSON.stringify([row.date, row.tool, row.model ?? "", row.externalId]);
}

// Idempotent: rows are daily totals, so conflicts overwrite the previous
// values for the same (date, tool, model, externalId, machineId) instead of
// adding. Cross-source dedup: an incoming row is skipped when a higher-
// priority source already covers its logical key; when the incoming row
// outranks existing rows, those are deleted and replaced.
// No multi-document transaction (standalone Mongo) — partial failures are
// safe to re-run.
export async function upsertUsageRows(
  rows: UsageRow[],
): Promise<{ upserted: number; skipped: number }> {
  if (rows.length === 0) return { upserted: 0, skipped: 0 };
  await connectDb();
  const identities = await identityMap();

  // Normalize model labels before any key is derived, so alias variants dedup
  // onto one canonical id (see src/lib/models.ts).
  rows = rows.map((r) => ({ ...r, model: canonicalizeModel(r.model) }));

  // Highest existing source priority per logical key touched by this batch.
  const keys = [...new Set(rows.map(logicalKey))].map(
    (k) => JSON.parse(k) as [string, string, string, string],
  );
  const existing: Array<{
    _id: { date: string; tool: string; model: string; externalId: string };
    sources: string[];
  }> = await UsageDaily.aggregate([
    {
      $match: {
        $or: keys.map(([date, tool, model, externalId]) => ({
          date,
          tool,
          model,
          externalId,
        })),
      },
    },
    {
      $group: {
        _id: {
          date: "$date",
          tool: "$tool",
          model: "$model",
          externalId: "$externalId",
        },
        sources: { $addToSet: "$source" },
      },
    },
  ]);
  const existingPriority = new Map(
    existing.map((e) => [
      logicalKey({ ...e._id }),
      Math.max(...e.sources.map((s) => SOURCE_PRIORITY[s] ?? 0)),
    ]),
  );

  // Winning (highest) incoming priority per logical key — a batch may carry
  // the same key from several sources.
  const incomingPriority = new Map<string, number>();
  for (const row of rows) {
    const key = logicalKey(row);
    const p = SOURCE_PRIORITY[row.source] ?? 0;
    if (p > (incomingPriority.get(key) ?? -1)) incomingPriority.set(key, p);
  }

  const writable: UsageRow[] = [];
  let skipped = 0;
  for (const row of rows) {
    const key = logicalKey(row);
    const incoming = SOURCE_PRIORITY[row.source] ?? 0;
    const winner = incomingPriority.get(key) ?? incoming;
    const current = existingPriority.get(key) ?? -1;
    // A row survives only if it matches the highest priority seen for its key
    // (existing rows and batch-mates included).
    if (incoming < Math.max(current, winner)) {
      skipped++;
      continue;
    }
    writable.push(row);
  }

  // The surviving source owns each key: drop every row of a strictly lower
  // source (covers demotion by a new higher source AND stale lower-source
  // rows that coexisted at the previous max — e.g. a manual row lingering
  // under uploader rows).
  const cleanupOr: Record<string, unknown>[] = [];
  for (const [key, winner] of incomingPriority) {
    const lowerSources = Object.keys(SOURCE_PRIORITY).filter(
      (s) => SOURCE_PRIORITY[s] < winner,
    );
    if (lowerSources.length === 0) continue;
    const [date, tool, model, externalId] = JSON.parse(key) as string[];
    cleanupOr.push({
      date,
      tool,
      model,
      externalId,
      source: { $in: lowerSources },
    });
  }
  // Legacy cleanup: rows written before the machineId dimension sit at
  // machineId "" — when the same source now writes machine-tagged rows for
  // the key, the "" row described the same usage and must go.
  for (const r of writable) {
    if ((r.machineId ?? "") === "") continue;
    cleanupOr.push({
      date: r.date,
      tool: r.tool,
      model: r.model ?? "",
      externalId: r.externalId,
      source: r.source,
      machineId: "",
    });
  }
  if (cleanupOr.length > 0) {
    await UsageDaily.deleteMany({ $or: cleanupOr });
  }

  if (writable.length > 0) {
    await UsageDaily.bulkWrite(
      writable.map((row) => ({
        updateOne: {
          filter: {
            date: row.date,
            tool: row.tool,
            model: row.model ?? "",
            externalId: row.externalId,
            machineId: row.machineId ?? "",
          },
          update: {
            $set: {
              memberId: identities.get(`${row.tool} ${row.externalId}`) ?? null,
              inputTokens: row.inputTokens ?? null,
              outputTokens: row.outputTokens ?? null,
              cacheReadTokens: row.cacheReadTokens ?? null,
              cacheCreationTokens: row.cacheCreationTokens ?? null,
              requests: row.requests ?? null,
              sessions: row.sessions ?? null,
              costEstimateCents: row.costEstimateCents ?? null,
              source: row.source,
              raw: row.raw ?? null,
            },
          },
          upsert: true,
        },
      })),
      { ordered: false },
    );
  }
  return { upserted: writable.length, skipped };
}

// Single shared path for the "usage rows link to members" invariant: register
// the mappings, then re-attach any previously unlinked rows. Every ingestion
// path (ingest API, manual entry, member CLI) must go through this.
export async function registerIdentities(
  entries: Array<{ memberId: string; tool: string; externalId: string }>,
): Promise<void> {
  if (entries.length === 0) return;
  await connectDb();
  await MemberIdentity.bulkWrite(
    entries.map((e) => ({
      updateOne: {
        filter: { tool: e.tool, externalId: e.externalId },
        update: { $setOnInsert: { memberId: new Types.ObjectId(e.memberId) } },
        upsert: true,
      },
    })),
    { ordered: false },
  );
  await relinkMemberIds();
}

// Auto-claim unmapped usage whose externalId IS a registered member's email
// (company-address scheme → collision-free; user-approved 2026-07-19).
// Piggybacks on registerIdentities' $setOnInsert, so an id already claimed
// by someone else is never reassigned. Called on member registration and
// after every poller sync (new rows may arrive for known emails).
export async function autoClaimEmailIdentities(): Promise<number> {
  await connectDb();
  const [members, unmapped] = await Promise.all([
    Member.find().select({ email: 1 }).lean(),
    UsageDaily.aggregate([
      { $match: { memberId: null } },
      { $group: { _id: { tool: "$tool", externalId: "$externalId" } } },
    ]),
  ]);
  // Case-insensitive email match; register the ORIGINAL externalId so the
  // identity mapping matches the usage rows exactly as the connector wrote them.
  const byEmail = new Map(members.map((m) => [m.email.toLowerCase(), String(m._id)]));
  const entries = unmapped
    .map((r) => ({ tool: r._id.tool as string, externalId: r._id.externalId as string }))
    .filter((r) => byEmail.has(r.externalId.toLowerCase()))
    .map((r) => ({ ...r, memberId: byEmail.get(r.externalId.toLowerCase())! }));
  if (entries.length > 0) await registerIdentities(entries);
  return entries.length;
}

// Re-attach member ids after a new identity mapping is registered — for both
// the daily and hourly usage collections.
export async function relinkMemberIds(): Promise<void> {
  await connectDb();
  // Minimal shared surface so the two differently-typed models iterate together.
  const collections = [UsageDaily, UsageHourly] as unknown as Array<{
    aggregate: (p: unknown[]) => Promise<Array<{ _id: { tool: string; externalId: string } }>>;
    updateMany: (f: unknown, u: unknown) => Promise<unknown>;
  }>;
  for (const Coll of collections) {
    const unlinked = await Coll.aggregate([
      { $match: { memberId: null } },
      { $group: { _id: { tool: "$tool", externalId: "$externalId" } } },
    ]);
    for (const u of unlinked) {
      const mapping = await MemberIdentity.findOne({
        tool: u._id.tool,
        externalId: u._id.externalId,
      }).lean();
      if (mapping) {
        await Coll.updateMany(
          { tool: u._id.tool, externalId: u._id.externalId, memberId: null },
          { $set: { memberId: mapping.memberId } },
        );
      }
    }
  }
}

// Hour-grained additive mirror. Same source-priority dedup as the daily upsert
// (keyed on hour, not date), but no legacy-machineId cleanup — this collection
// is new so no machineId "" rows predate it. Never summed with usage_daily.
export async function upsertHourlyRows(
  rows: UsageHourlyRow[],
): Promise<{ upserted: number; skipped: number }> {
  if (rows.length === 0) return { upserted: 0, skipped: 0 };
  await connectDb();
  const identities = await identityMap();

  // Same alias normalization as the daily upsert.
  rows = rows.map((r) => ({ ...r, model: canonicalizeModel(r.model) }));

  const hKey = (r: UsageHourlyRow) =>
    JSON.stringify([r.hour, r.tool, r.model ?? "", r.externalId]);

  const keys = [...new Set(rows.map(hKey))].map(
    (k) => JSON.parse(k) as [string, string, string, string],
  );
  const existing: Array<{
    _id: { hour: string; tool: string; model: string; externalId: string };
    sources: string[];
  }> = await UsageHourly.aggregate([
    {
      $match: {
        $or: keys.map(([hour, tool, model, externalId]) => ({
          hour,
          tool,
          model,
          externalId,
        })),
      },
    },
    {
      $group: {
        _id: {
          hour: "$hour",
          tool: "$tool",
          model: "$model",
          externalId: "$externalId",
        },
        sources: { $addToSet: "$source" },
      },
    },
  ]);
  const existingPriority = new Map(
    existing.map((e) => [
      JSON.stringify([e._id.hour, e._id.tool, e._id.model, e._id.externalId]),
      Math.max(...e.sources.map((s) => SOURCE_PRIORITY[s] ?? 0)),
    ]),
  );
  const incomingPriority = new Map<string, number>();
  for (const r of rows) {
    const p = SOURCE_PRIORITY[r.source] ?? 0;
    const k = hKey(r);
    if (p > (incomingPriority.get(k) ?? -1)) incomingPriority.set(k, p);
  }

  const writable: UsageHourlyRow[] = [];
  let skipped = 0;
  for (const r of rows) {
    const k = hKey(r);
    const incoming = SOURCE_PRIORITY[r.source] ?? 0;
    const winner = incomingPriority.get(k) ?? incoming;
    const current = existingPriority.get(k) ?? -1;
    if (incoming < Math.max(current, winner)) {
      skipped++;
      continue;
    }
    writable.push(r);
  }

  const cleanupOr: Record<string, unknown>[] = [];
  for (const [k, winner] of incomingPriority) {
    const lower = Object.keys(SOURCE_PRIORITY).filter(
      (s) => SOURCE_PRIORITY[s] < winner,
    );
    if (lower.length === 0) continue;
    const [hour, tool, model, externalId] = JSON.parse(k) as string[];
    cleanupOr.push({ hour, tool, model, externalId, source: { $in: lower } });
  }
  if (cleanupOr.length > 0) await UsageHourly.deleteMany({ $or: cleanupOr });

  if (writable.length > 0) {
    await UsageHourly.bulkWrite(
      writable.map((r) => ({
        updateOne: {
          filter: {
            hour: r.hour,
            tool: r.tool,
            model: r.model ?? "",
            externalId: r.externalId,
            machineId: r.machineId ?? "",
          },
          update: {
            $set: {
              memberId: identities.get(`${r.tool} ${r.externalId}`) ?? null,
              inputTokens: r.inputTokens ?? null,
              outputTokens: r.outputTokens ?? null,
              cacheReadTokens: r.cacheReadTokens ?? null,
              cacheCreationTokens: r.cacheCreationTokens ?? null,
              requests: r.requests ?? null,
              source: r.source,
            },
          },
          upsert: true,
        },
      })),
      { ordered: false },
    );
  }
  return { upserted: writable.length, skipped };
}

// Store plan-limit snapshots for a member's Claude account(s). Idempotent per
// (date, member, accountEmail, window) — one reading per account per day.
export async function upsertLimitSnapshots(
  memberId: string,
  snapshots: LimitSnapshotInput[],
): Promise<{ upserted: number }> {
  if (snapshots.length === 0) return { upserted: 0 };
  await connectDb();
  const mid = new Types.ObjectId(memberId);
  await LimitSnapshot.bulkWrite(
    snapshots.map((s) => ({
      updateOne: {
        filter: {
          date: s.date,
          memberId: mid,
          accountEmail: s.accountEmail,
          organization: s.organization ?? "",
          window: s.window,
        },
        update: {
          $set: {
            utilizationPct: s.utilizationPct,
            subscriptionType: s.subscriptionType ?? null,
            rateLimitTier: s.rateLimitTier ?? null,
            resetsAt: s.resetsAt ?? null,
            raw: s.raw ?? null,
          },
          // Keep the day's high-water mark: $max never lowers it.
          $max: { peakPct: s.utilizationPct },
        },
        upsert: true,
      },
    })),
    { ordered: false },
  );
  return { upserted: snapshots.length };
}

export async function recordSyncRun(
  tool: string,
  status: "ok" | "error",
  opts: { lastSyncedDate?: string; message?: string } = {},
): Promise<void> {
  await connectDb();
  await SyncRun.create({
    tool,
    status,
    lastSyncedDate: opts.lastSyncedDate ?? null,
    message: opts.message ?? null,
  });
}

// Latest fully-synced day for a connector, used as the incremental cursor.
export async function lastSyncedDate(tool: string): Promise<string | null> {
  await connectDb();
  const row = await SyncRun.findOne({ tool, status: "ok" })
    .sort({ _id: -1 })
    .lean();
  return row?.lastSyncedDate ?? null;
}
