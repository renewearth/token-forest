import type { Types } from "mongoose";
import {
  connectDb,
  MemberIdentity,
  UsageDaily,
  UsageDailyLegacy,
  UsageHourly,
  UsageSession,
} from "@/lib/db";
import { anonymizeMachineId } from "@/lib/machine-id";
import { canonicalizeModel } from "@/lib/models";
import type { DateBasis, FieldEvidence, UsageHourlyRow, UsageRow, UsageSessionRow } from "@/lib/types";
import { upsertHourlyRows, upsertUsageRows } from "@/lib/usage";

// Collection v2 (spec 2026-09-30 §3.1): the uploader sends session-grained
// rows; usagesessions is the source of truth and the uploader rows of
// usagedailies/usagehourlies are DERIVED from it, so every dashboard, growth
// and report query keeps reading the same collections unchanged.

// machineId of every derived usagedailies/usagehourlies row. Not a device —
// device lists must exclude it (per-device figures come from usagesessions).
export const DERIVED_MACHINE_ID = "sessions";

export type ToolDate = { tool: string; date: string };

const VALUE_FIELDS = [
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheCreationTokens",
  "requests",
] as const;
type ValueField = (typeof VALUE_FIELDS)[number];
type Evidence = "known" | "unknown" | "unsupported";
const evidenceOf = (r: { fieldEvidence?: FieldEvidence } & Partial<Record<ValueField, number | null>>, f: ValueField): Evidence =>
  // Older parsers defaulted absent counters to zero. Without explicit
  // evidence, a stored zero cannot prove that the source reported zero.
  r.fieldEvidence?.[f] ?? (r[f] == null || r[f] === 0 ? "unknown" : "known");
const maxNullable = (a: number | null, b: number | null): number | null =>
  a == null ? b : b == null ? a : Math.max(a, b);
const mergeEvidence = (a: Evidence, b: Evidence): Evidence =>
  a === "known" || b === "known" ? "known" : a === "unsupported" && b === "unsupported" ? "unsupported" : "unknown";
const mergeDateBasis = (a: DateBasis | undefined, b: DateBasis | undefined): DateBasis =>
  (a ?? "KST") === (b ?? "KST") ? (a ?? b ?? "KST") : "미확인";

// Which Claude organization a session bucket belongs to. Stronger evidence
// replaces weaker (transcript > hook); two organizations at the same strength
// become "mixed". Never part of the row key, so it cannot split a session.
export type AccountEvidence = "transcript" | "hook";
export type AccountTag = { accountOrg: string; accountEvidence: AccountEvidence } | null;
const ACCOUNT_RANK: Record<AccountEvidence, number> = { hook: 1, transcript: 2 };
export const MIXED_ORG = "mixed";
export function accountTag(r: { accountOrg?: string | null; accountEvidence?: string | null }): AccountTag {
  const accountOrg = (r.accountOrg ?? "").trim();
  return accountOrg !== "" && (r.accountEvidence === "transcript" || r.accountEvidence === "hook")
    ? { accountOrg, accountEvidence: r.accountEvidence }
    : null;
}
export function mergeAccountTag(a: AccountTag, b: AccountTag): AccountTag {
  if (!a) return b;
  if (!b) return a;
  const ra = ACCOUNT_RANK[a.accountEvidence];
  const rb = ACCOUNT_RANK[b.accountEvidence];
  if (ra !== rb) return ra > rb ? a : b;
  return a.accountOrg === b.accountOrg ? a : { accountOrg: MIXED_ORG, accountEvidence: a.accountEvidence };
}
const accountFields = (t: AccountTag) => (t ? { accountOrg: t.accountOrg, accountEvidence: t.accountEvidence } : {});

type Normalized = {
  tool: string;
  sessionId: string;
  hour: string;
  date: string;
  model: string;
  provider: string | null; // null = not reported by this row
  account: AccountTag;
  parserVersion: number;
  machineIds: string[];
  fieldEvidence: FieldEvidence;
  dateBasis: DateBasis;
} & Record<ValueField, number | null>;

const sessionKey = (r: { tool: string; sessionId: string; hour: string; model: string }) =>
  JSON.stringify([r.tool, r.sessionId, r.hour, r.model]);

const toolDateKey = (t: ToolDate) => `${t.tool}|${t.date}`;

function uniqueToolDates(pairs: ToolDate[]): ToolDate[] {
  const seen = new Map<string, ToolDate>();
  for (const p of pairs) seen.set(toolDateKey(p), { tool: p.tool, date: p.date });
  return [...seen.values()].sort((a, b) =>
    a.tool === b.tool ? a.date.localeCompare(b.date) : a.tool.localeCompare(b.tool),
  );
}

// Inclusive hour-string range of one date — avoids a regex on `hour`.
const hourRange = (date: string) => ({ $gte: `${date}T00`, $lte: `${date}T23` });

// Model canonicalizer seam: production always uses canonicalizeModel; tests
// inject one to simulate an ALIASES entry added after docs were stored.
export type Canonicalize = (raw: string | null | undefined) => string;
export type CanonOpts = { canonicalize?: Canonicalize };

function normalize(r: UsageSessionRow, canon: Canonicalize): Normalized {
  const machineId = anonymizeMachineId((r.machineId ?? "").trim());
  const provider = (r.provider ?? "").trim();
  return {
    tool: r.tool,
    sessionId: r.sessionId,
    hour: r.hour,
    date: r.hour.slice(0, 10),
    model: canon(r.model),
    provider: provider === "" ? null : provider,
    account: accountTag(r),
    parserVersion: r.parserVersion,
    machineIds: machineId === "" ? [] : [machineId],
    fieldEvidence: Object.fromEntries(VALUE_FIELDS.map((f) => [f, evidenceOf(r, f)])),
    dateBasis: r.dateBasis ?? "KST",
    inputTokens: r.inputTokens ?? null,
    outputTokens: r.outputTokens ?? null,
    cacheReadTokens: r.cacheReadTokens ?? null,
    cacheCreationTokens: r.cacheCreationTokens ?? null,
    requests: r.requests ?? null,
  };
}

// Apply the server merge rule inside one batch too, so the same key sent twice
// in a request behaves exactly like two requests: higher parserVersion wins
// outright, equal versions max-merge field by field, lower versions drop.
function mergeInto(cur: Normalized, next: Normalized): Normalized {
  if (next.parserVersion < cur.parserVersion) return cur;
  const machineIds = [...new Set([...cur.machineIds, ...next.machineIds])];
  const account = mergeAccountTag(cur.account, next.account);
  if (next.parserVersion > cur.parserVersion) return { ...next, machineIds, account };
  const merged: Normalized = {
    ...cur,
    machineIds,
    account,
    provider: next.provider ?? cur.provider,
    fieldEvidence: { ...cur.fieldEvidence },
    dateBasis: mergeDateBasis(cur.dateBasis, next.dateBasis),
  };
  for (const f of VALUE_FIELDS) {
    merged[f] = maxNullable(cur[f], next[f]);
    merged.fieldEvidence[f] = mergeEvidence(evidenceOf(cur, f), evidenceOf(next, f));
  }
  return merged;
}

type StoredDoc = {
  _id: Types.ObjectId;
  tool: string;
  sessionId: string;
  hour: string;
  date: string;
  model: string;
  provider: string;
  accountOrg?: string;
  accountEvidence?: string;
  parserVersion: number;
  machineIds: string[];
  fieldEvidence?: FieldEvidence;
  dateBasis?: DateBasis;
} & Record<ValueField, number | null>;

// Same rule as mergeInto, for stored docs: higher parserVersion wins outright,
// equal versions max-merge field by field; machineIds always union.
function mergeStored(cur: StoredDoc, next: StoredDoc): StoredDoc {
  const machineIds = [...new Set([...(cur.machineIds ?? []), ...(next.machineIds ?? [])])];
  const provider = cur.provider || next.provider || "";
  const account = accountFields(mergeAccountTag(accountTag(cur), accountTag(next)));
  if (next.parserVersion < cur.parserVersion) return { ...cur, machineIds, provider, ...account };
  if (next.parserVersion > cur.parserVersion) {
    return { ...next, _id: cur._id, machineIds, provider: next.provider || cur.provider || "", ...account };
  }
  const merged: StoredDoc = { ...cur, machineIds, provider, ...account, fieldEvidence: { ...cur.fieldEvidence }, dateBasis: mergeDateBasis(cur.dateBasis, next.dateBasis) };
  for (const f of VALUE_FIELDS) {
    merged[f] = maxNullable(cur[f], next[f]);
    merged.fieldEvidence![f] = mergeEvidence(evidenceOf(cur, f), evidenceOf(next, f));
  }
  return merged;
}

// Alias-label repair (final-review F1). A doc stored under a label that a
// LATER ALIASES entry remaps (e.g. "opus-5" before it mapped to
// "claude-opus-5") has a different unique key than the canonical rows a resend
// carries — the resend would insert a SECOND doc at the same parserVersion,
// R8 (which only removes lower versions) would keep both, and derivation
// would count the session twice. So, for the batch's sessions, every group of
// stored docs that canonicalizes onto one key is collapsed into one doc under
// the canonical label: the canonical doc if one exists (alias values merged
// in, alias docs deleted), else the highest-version alias doc is relabelled.
// Returns the stored docs as they are after the repair, plus the docs whose
// (tool, date) must be re-derived.
async function mergeAliasDocs(
  docs: StoredDoc[],
  canon: Canonicalize,
): Promise<{ docs: StoredDoc[]; repaired: StoredDoc[] }> {
  const groups = new Map<string, StoredDoc[]>();
  for (const d of docs) {
    const k = sessionKey({ ...d, model: canon(d.model) });
    const g = groups.get(k) ?? [];
    g.push(d);
    groups.set(k, g);
  }
  const out: StoredDoc[] = [];
  const repaired: StoredDoc[] = [];
  const updates = [];
  const deletes: Types.ObjectId[] = [];
  for (const group of groups.values()) {
    const model = canon(group[0].model);
    if (group.every((d) => d.model === model)) {
      out.push(...group); // already canonical (the unique index allows one)
      continue;
    }
    const survivor =
      group.find((d) => d.model === model) ??
      group.reduce((a, b) => (b.parserVersion > a.parserVersion ? b : a));
    let merged = survivor;
    for (const d of group) if (d !== survivor) merged = mergeStored(merged, d);
    merged = { ...merged, _id: survivor._id, model };
    updates.push({
      updateOne: {
        filter: { _id: survivor._id },
        update: {
          $set: {
            model,
            parserVersion: merged.parserVersion,
            provider: merged.provider,
            ...accountFields(accountTag(merged)),
            machineIds: merged.machineIds,
            fieldEvidence: merged.fieldEvidence,
            dateBasis: merged.dateBasis,
            ...Object.fromEntries(VALUE_FIELDS.map((f) => [f, merged[f]])),
          },
        },
      },
    });
    for (const d of group) if (d !== survivor) deletes.push(d._id);
    repaired.push(...group);
    out.push(merged);
  }
  // Survivor first, then the absorbed docs: a failure in between leaves an
  // extra copy that the derivation's per-(session, hour) max still ignores,
  // and the next upload finishes the repair.
  if (updates.length > 0) await UsageSession.bulkWrite(updates, { ordered: false });
  if (deletes.length > 0) await UsageSession.deleteMany({ _id: { $in: deletes } });
  return { docs: out, repaired };
}

// Upsert session rows for one member (externalId is server-forced).
// Merge rule per key (tool, sessionId, hour, model):
//   - new key or same parserVersion → $max per value field (a lagging copy on
//     another machine can never lower a total); machineIds $addToSet
//   - higher incoming parserVersion → $set (a parser fix may LOWER numbers)
//   - lower incoming parserVersion  → skipped
// Superseded buckets (controller Ruling R8): a parser fix can move tokens to a
// DIFFERENT key (another hour, model or sessionId split), which the per-key
// override never reaches — the old lower-version docs would be counted twice
// forever. So for each (tool, sessionId) in the batch at version v, docs of
// that session with parserVersion < v, hour >= the batch's minimum hour for
// the session, and a key NOT in the batch are deleted (their (tool, date) is
// added to `touched` so the derived rows are recomputed).
// CONTRACT: the uploader must send ALL of a session's buckets from its
// since-window in ONE request (Task 5 guarantees this) — otherwise a split
// upload would delete the buckets carried by the other request. Buckets
// before the minimum hour (outside the resend window, e.g. logs rotated away)
// are kept.
// Stored docs under an alias label are first folded into the canonical key
// (mergeAliasDocs), so the prefetch below sees them.
// Idempotent; safe to re-run after a partial failure.
export async function upsertSessionRows(
  externalId: string,
  rows: UsageSessionRow[],
  opts: CanonOpts = {},
): Promise<{ upserted: number; touched: ToolDate[] }> {
  if (rows.length === 0) return { upserted: 0, touched: [] };
  const canon = opts.canonicalize ?? canonicalizeModel;
  await connectDb();

  const batch = new Map<string, Normalized>();
  for (const raw of rows) {
    const n = normalize(raw, canon);
    const k = sessionKey(n);
    const cur = batch.get(k);
    batch.set(k, cur ? mergeInto(cur, n) : n);
  }
  const incoming = [...batch.values()];
  const touched = uniqueToolDates(incoming);

  // Existing parserVersion per key, fetched once: (externalId, tool,
  // sessionId $in) rides the unique index prefix; chunked to bound query size.
  const existing = new Map<string, number>();
  const fetched: StoredDoc[] = [];
  const idsByTool = new Map<string, Set<string>>();
  for (const r of incoming) {
    const s = idsByTool.get(r.tool) ?? new Set<string>();
    s.add(r.sessionId);
    idsByTool.set(r.tool, s);
  }
  const CHUNK = 5000;
  for (const [tool, ids] of idsByTool) {
    const all = [...ids];
    for (let i = 0; i < all.length; i += CHUNK) {
      const docs = await UsageSession.find({
        externalId,
        tool,
        sessionId: { $in: all.slice(i, i + CHUNK) },
      })
        .select({
          tool: 1,
          sessionId: 1,
          hour: 1,
          date: 1,
          model: 1,
          provider: 1,
          accountOrg: 1,
          accountEvidence: 1,
          parserVersion: 1,
          machineIds: 1,
          fieldEvidence: 1,
          dateBasis: 1,
          ...Object.fromEntries(VALUE_FIELDS.map((f) => [f, 1])),
        })
        .lean<StoredDoc[]>();
      fetched.push(...docs);
    }
  }
  const { docs: existingDocs, repaired } = await mergeAliasDocs(fetched, canon);
  const existingByKey = new Map(existingDocs.map((d) => [sessionKey(d), d]));
  for (const d of existingDocs) existing.set(sessionKey(d), d.parserVersion);

  const identities = await MemberIdentity.find({
    externalId,
    tool: { $in: [...idsByTool.keys()] },
  }).lean();
  const memberByTool = new Map(identities.map((i) => [i.tool, i.memberId]));

  const ops = [];
  for (const r of incoming) {
    const prev = existing.get(sessionKey(r));
    if (prev !== undefined && r.parserVersion < prev) continue; // older parser
    const filter = {
      externalId,
      tool: r.tool,
      sessionId: r.sessionId,
      hour: r.hour,
      model: r.model,
    };
    const values = Object.fromEntries(VALUE_FIELDS.map((f) => [f, r[f]]));
    const stored = existingByKey.get(sessionKey(r));
    const merged = stored ? mergeStored(stored, { ...r, _id: stored._id, provider: r.provider ?? "" }) : r;
    const account = accountFields(mergeAccountTag(stored ? accountTag(stored) : null, r.account));
    const addToSet =
      r.machineIds.length > 0 ? { $addToSet: { machineIds: { $each: r.machineIds } } } : {};
    const memberId = memberByTool.get(r.tool) ?? null;
    if (prev !== undefined && r.parserVersion > prev) {
      // Overwrite. The version guard makes a concurrent newer write win.
      ops.push({
        updateOne: {
          filter: { ...filter, parserVersion: { $lt: r.parserVersion } },
          update: {
            $set: {
              ...values,
              fieldEvidence: r.fieldEvidence,
              dateBasis: r.dateBasis,
              parserVersion: r.parserVersion,
              memberId,
              ...(r.provider !== null ? { provider: r.provider } : {}),
              ...account,
            },
            ...addToSet,
          },
        },
      });
      continue;
    }
    // New key (prev undefined) → UNFILTERED upsert on the unique-index key,
    // since the pre-fetch saw no doc. Two requests inserting the same new key
    // concurrently both reach the upsert; MongoDB (4.2+) retries an upsert
    // that hits a duplicate key when the filter is an equality match on the
    // unique index, so the loser becomes a plain $max update. Residual gap:
    // if the winner carried a HIGHER parserVersion, the loser's lower-version
    // values max-merge into it unguarded, and the excess stays until a still
    // higher parserVersion rewrites that key. Tolerated: it needs two devices
    // on different parser versions racing on a brand-new key within one
    // request's lifetime.
    ops.push({
      updateOne: {
        // Existing doc: only while its version still equals ours (a concurrent
        // upgrade must not be max-merged with older-parser numbers).
        filter: prev === undefined ? filter : { ...filter, parserVersion: r.parserVersion },
        update: {
          $max: Object.fromEntries(VALUE_FIELDS.filter((f) => r[f] !== null).map((f) => [f, r[f]])),
          $set: { memberId, fieldEvidence: merged.fieldEvidence, dateBasis: merged.dateBasis, ...(r.provider !== null ? { provider: r.provider } : {}), ...account },
          $setOnInsert: {
            date: r.date,
            parserVersion: r.parserVersion,
            ...Object.fromEntries(VALUE_FIELDS.filter((f) => r[f] === null).map((f) => [f, null])),
            ...(r.provider === null ? { provider: "" } : {}),
          },
          ...addToSet,
        },
        upsert: prev === undefined,
      },
    });
  }
  if (ops.length > 0) await UsageSession.bulkWrite(ops, { ordered: false });

  // Superseded-bucket cleanup (Ruling R8) — after the write, so a failed
  // write never leaves a session with fewer buckets than before.
  const perSession = new Map<string, { version: number; minHour: string }>();
  for (const r of incoming) {
    const k = JSON.stringify([r.tool, r.sessionId]);
    const cur = perSession.get(k);
    perSession.set(k, {
      version: Math.max(cur?.version ?? 0, r.parserVersion),
      minHour: cur && cur.minHour < r.hour ? cur.minHour : r.hour,
    });
  }
  const superseded = existingDocs.filter((d) => {
    const s = perSession.get(JSON.stringify([d.tool, d.sessionId]));
    return (
      s !== undefined &&
      d.parserVersion < s.version &&
      d.hour >= s.minHour &&
      !batch.has(sessionKey(d))
    );
  });
  if (superseded.length > 0) {
    await UsageSession.bulkWrite(
      superseded.map((d) => ({
        deleteOne: {
          // Version guard: never delete a doc a concurrent request upgraded.
          filter: {
            _id: d._id,
            parserVersion: { $lt: perSession.get(JSON.stringify([d.tool, d.sessionId]))!.version },
          },
        },
      })),
      { ordered: false },
    );
  }
  const renamed = await supersedeRenamedGrokIds(externalId, incoming);
  return {
    upserted: ops.length,
    touched: uniqueToolDates([...touched, ...repaired, ...superseded, ...renamed]),
  };
}

// grok's log has no session id, so the uploader keys one pseudo-session per
// device per KST day: `grok-<device tag>-<date>`. Uploader PARSER_VERSION 3
// (final-review F3) changed the tag from raw machineId chars to a sha1 tag, so
// the older docs carry a DIFFERENT sessionId, which R8 (scoped to the batch's
// sessionIds) never reaches — both would be counted. For each device
// (machineIds) sending grok fallback rows at version v, its older-version
// fallback docs dated >= that device's minimum date and not in the batch are
// superseded (same windowing as R8). Explicit grok ids (a future wrapper
// logging a conversation id) never match the pattern and are untouched.
const GROK_FALLBACK_ID = /^grok-.{1,8}-(\d{4}-\d{2}-\d{2})$/;
async function supersedeRenamedGrokIds(
  externalId: string,
  incoming: Normalized[],
): Promise<ToolDate[]> {
  const perDevice = new Map<string, { version: number; minDate: string; ids: Set<string> }>();
  for (const r of incoming) {
    if (r.tool !== "grok" || !GROK_FALLBACK_ID.test(r.sessionId)) continue;
    for (const m of r.machineIds) {
      const cur = perDevice.get(m) ?? { version: 0, minDate: r.date, ids: new Set<string>() };
      cur.version = Math.max(cur.version, r.parserVersion);
      if (r.date < cur.minDate) cur.minDate = r.date;
      cur.ids.add(r.sessionId);
      perDevice.set(m, cur);
    }
  }
  const out: ToolDate[] = [];
  for (const [machineId, dev] of perDevice) {
    const docs = await UsageSession.find({
      externalId,
      tool: "grok",
      machineIds: machineId,
      date: { $gte: dev.minDate },
      parserVersion: { $lt: dev.version },
    })
      .select({ sessionId: 1, date: 1 })
      .lean();
    const stale = docs.filter((d) => {
      const m = GROK_FALLBACK_ID.exec(d.sessionId);
      return m !== null && m[1] === d.date && !dev.ids.has(d.sessionId);
    });
    if (stale.length === 0) continue;
    await UsageSession.deleteMany({
      _id: { $in: stale.map((d) => d._id) },
      parserVersion: { $lt: dev.version }, // never delete a concurrently upgraded doc
    });
    for (const d of stale) out.push({ tool: "grok", date: d.date });
  }
  return out;
}

// (tool, date) pairs of this member already covered by session rows, as
// `${tool}|${date}` keys. The ingest route uses it to divert v1 daily rows
// that arrive AFTER v2 coverage exists (ledger Ruling R1).
export async function sessionCoverage(
  externalId: string,
  pairs: ToolDate[],
): Promise<Set<string>> {
  const uniq = uniqueToolDates(pairs);
  if (uniq.length === 0) return new Set();
  await connectDb();
  const found: Array<{ _id: ToolDate }> = await UsageSession.aggregate([
    { $match: { externalId, $or: uniq.map(({ tool, date }) => ({ tool, date })) } },
    { $group: { _id: { tool: "$tool", date: "$date" } } },
  ]);
  return new Set(found.map((f) => toolDateKey(f._id)));
}

// Ruling R1: incoming v1 uploader daily rows whose (tool, date) is already
// session-covered go STRAIGHT to usagedailylegacies — they never enter
// usagedailies, so no aggregate ever double counts them, whether the coverage
// came from the same request or an earlier one. Same backup semantics as
// divertLegacyRows: keyed by the usagedailies identity (canonical model), a
// re-sent row replaces its backup (daily totals overwrite; last row of the
// batch wins, as in upsertUsageRows). Rows must already carry the member's
// externalId and an anonymized machineId. Returns the number of rows backed up.
export async function backupIncomingLegacyRows(rows: UsageRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  await connectDb();
  const byKey = new Map<string, UsageRow>();
  for (const r of rows) {
    const row = { ...r, model: canonicalizeModel(r.model) };
    byKey.set(
      JSON.stringify([row.date, row.tool, row.model, row.externalId, row.machineId ?? ""]),
      row,
    );
  }
  const unique = [...byKey.values()];
  const identities = await MemberIdentity.find({
    $or: unique.map((r) => ({ tool: r.tool, externalId: r.externalId })),
  }).lean();
  const memberOf = new Map(identities.map((i) => [`${i.tool} ${i.externalId}`, i.memberId]));
  const now = new Date();
  await UsageDailyLegacy.bulkWrite(
    unique.map((r) => {
      const key = {
        date: r.date,
        tool: r.tool,
        model: r.model ?? "",
        externalId: r.externalId,
        machineId: r.machineId ?? "",
      };
      return {
        replaceOne: {
          filter: key,
          replacement: {
            ...key,
            memberId: memberOf.get(`${r.tool} ${r.externalId}`) ?? null,
            inputTokens: r.inputTokens ?? null,
            outputTokens: r.outputTokens ?? null,
            cacheReadTokens: r.cacheReadTokens ?? null,
            cacheCreationTokens: r.cacheCreationTokens ?? null,
            requests: r.requests ?? null,
            sessions: r.sessions ?? null,
            fieldEvidence: r.fieldEvidence,
            dateBasis: r.dateBasis ?? "미확인",
            costEstimateCents: r.costEstimateCents ?? null,
            source: r.source,
            raw: r.raw ?? null,
            updatedAt: now,
            divertedAt: now,
          },
          upsert: true,
        },
      };
    }),
    { ordered: false },
  );
  return unique.length;
}

// Move this member's v1 uploader rows for session-covered (tool, date) pairs
// out of the aggregates (spec §3.1 + §0.1): daily rows go to
// usagedailylegacies (reversible), then leave usagedailies. Derived rows
// (machineId "sessions") and other sources (poller, manual) are untouched.
// Backup is written BEFORE the delete and upserts by the usagedailies key, so
// a crash between the two steps, or a v1 row re-sent later, just re-diverts
// onto the same backup row (latest daily total wins, as in usagedailies).
// Returns the number of daily rows diverted.
export async function divertLegacyRows(
  externalId: string,
  covered: ToolDate[],
): Promise<number> {
  const uniq = uniqueToolDates(covered);
  if (uniq.length === 0) return 0;
  await connectDb();
  const legacyFilter = {
    externalId,
    source: "uploader",
    machineId: { $ne: DERIVED_MACHINE_ID },
  };

  const docs = await UsageDaily.find({
    ...legacyFilter,
    $or: uniq.map(({ tool, date }) => ({ tool, date })),
  }).lean();
  if (docs.length > 0) {
    const divertedAt = new Date();
    await UsageDailyLegacy.bulkWrite(
      docs.map((d) => {
        // Drop _id: the backup is keyed by the usagedailies identity, and a
        // re-diverted row (new _id) must replace — not duplicate — its backup.
        const { _id: droppedId, ...rest } = d;
        void droppedId;
        return {
          replaceOne: {
            filter: {
              date: d.date,
              tool: d.tool,
              model: d.model,
              externalId: d.externalId,
              machineId: d.machineId,
            },
            replacement: { ...rest, divertedAt },
            upsert: true,
          },
        };
      }),
      { ordered: false },
    );
    await UsageDaily.deleteMany({ _id: { $in: docs.map((d) => d._id) } });
  }

  // Hourly v1 rows are deleted WITHOUT a backup: usagehourlies is only an
  // hour-grained mirror of the same parse (heatmap/drill-down, never summed
  // with dailies — see UsageHourlyDoc), and the daily totals above are what a
  // rollback would restore; the derived hourly rows replace them.
  await UsageHourly.deleteMany({
    ...legacyFilter,
    $or: uniq.map(({ tool, date }) => ({ tool, hour: hourRange(date) })),
  });

  return docs.length;
}

type SumGroup = Record<ValueField, number | null> & { fieldEvidence: FieldEvidence; dateBasis: DateBasis };
type DailyGroup = { _id: { date: string; tool: string; model: string }; sessionIds: string[] } & SumGroup;
type HourlyGroup = { _id: { hour: string; tool: string; model: string } } & SumGroup;

const zero = (): SumGroup =>
  ({ ...Object.fromEntries(VALUE_FIELDS.map((f) => [f, null])), fieldEvidence: {}, dateBasis: "KST" }) as SumGroup;
const sumNullable = (a: number | null, b: number | null): number | null =>
  a == null ? b : b == null ? a : a + b;
const sumEvidence = (a: Evidence | undefined, b: Evidence): Evidence =>
  a === undefined ? b : a === "known" && b === "known" ? "known" :
    a === "unsupported" && b === "unsupported" ? "unsupported" : "unknown";

// Session docs of the touched (tool, date) pairs, folded to one bucket per
// (tool, sessionId, hour, CANONICAL model). Stored models were canonical at
// write time, but the alias map can change later, so two stored labels may
// denote one bucket. Those are copies of the same tokens (a resend under the
// new label), never additive — so the fold takes the MAX per field (second
// guard behind mergeAliasDocs; final-review F1). Distinct sessions and hours
// still add up in the sums below.
async function canonicalBuckets(
  match: object,
  canon: Canonicalize,
): Promise<Array<{ tool: string; sessionId: string; hour: string; date: string; model: string } & SumGroup>> {
  const docs = await UsageSession.find(match)
    .select({
      _id: 0,
      tool: 1,
      sessionId: 1,
      hour: 1,
      date: 1,
      model: 1,
      fieldEvidence: 1,
      dateBasis: 1,
      ...Object.fromEntries(VALUE_FIELDS.map((f) => [f, 1])),
    })
    .lean<Array<{ tool: string; sessionId: string; hour: string; date: string; model: string } & SumGroup>>();
  const out = new Map<string, (typeof docs)[number]>();
  for (const d of docs) {
    const model = canon(d.model);
    const k = sessionKey({ ...d, model });
    const cur = out.get(k);
    if (!cur) {
      out.set(k, { ...d, model });
      continue;
    }
    for (const f of VALUE_FIELDS) {
      const currentEvidence = evidenceOf(cur, f);
      cur[f] = maxNullable(cur[f], d[f]);
      cur.fieldEvidence = { ...cur.fieldEvidence, [f]: mergeEvidence(currentEvidence, evidenceOf(d, f)) };
    }
    cur.dateBasis = mergeDateBasis(cur.dateBasis, d.dateBasis);
  }
  return [...out.values()];
}

// Recompute this member's derived uploader rows for the touched (tool, date)
// pairs from usagesessions: divert v1 rows first, then write per (date, tool,
// model) daily totals and per (hour, tool, model) hourly totals through the
// existing upserts (so poller > uploader > manual priority still applies),
// then drop derived rows that no longer have a session aggregate (e.g. a model
// label re-canonicalized).
export async function deriveUploaderRows(
  externalId: string,
  touched: ToolDate[],
  opts: CanonOpts = {},
): Promise<{ daily: number; hourly: number; divertedLegacy: number }> {
  const uniq = uniqueToolDates(touched);
  if (uniq.length === 0) return { daily: 0, hourly: 0, divertedLegacy: 0 };
  const canon = opts.canonicalize ?? canonicalizeModel;
  await connectDb();

  const divertedLegacy = await divertLegacyRows(externalId, uniq);
  const match = { externalId, $or: uniq.map(({ tool, date }) => ({ tool, date })) };
  // Canonical buckets summed per daily / hourly key. Summing here (not in
  // upsertUsageRows, which re-canonicalizes and would $set two collapsing
  // groups — losing tokens) keeps alias variants on one row.
  const buckets = await canonicalBuckets(match, canon);
  const dailyMap = new Map<string, DailyGroup>();
  const hourlyMap = new Map<string, HourlyGroup>();
  for (const b of buckets) {
    const dk = JSON.stringify([b.date, b.tool, b.model]);
    const firstDailyBucket = !dailyMap.has(dk);
    const dg = dailyMap.get(dk) ?? {
      _id: { date: b.date, tool: b.tool, model: b.model },
      sessionIds: [],
      ...zero(),
    };
    const hk = JSON.stringify([b.hour, b.tool, b.model]);
    const firstHourlyBucket = !hourlyMap.has(hk);
    const hg = hourlyMap.get(hk) ?? { _id: { hour: b.hour, tool: b.tool, model: b.model }, ...zero() };
    for (const f of VALUE_FIELDS) {
      dg[f] = sumNullable(dg[f], b[f]);
      hg[f] = sumNullable(hg[f], b[f]);
      dg.fieldEvidence[f] = sumEvidence(dg.fieldEvidence[f], evidenceOf(b, f));
      hg.fieldEvidence[f] = sumEvidence(hg.fieldEvidence[f], evidenceOf(b, f));
    }
    dg.dateBasis = firstDailyBucket ? b.dateBasis ?? "KST" : mergeDateBasis(dg.dateBasis, b.dateBasis);
    hg.dateBasis = firstHourlyBucket ? b.dateBasis ?? "KST" : mergeDateBasis(hg.dateBasis, b.dateBasis);
    dg.sessionIds.push(b.sessionId);
    dailyMap.set(dk, dg);
    hourlyMap.set(hk, hg);
  }

  // ---- daily ----
  const dailyAgg = [...dailyMap.values()];
  // Distinct sessions per (date, tool) — a session spanning models counts once.
  const sessionsPerDay = new Map<string, Set<string>>();
  const sessionEvidenceByDay = new Map<string, Evidence>();
  for (const b of buckets) {
    const key = toolDateKey(b);
    const evidence = b.fieldEvidence?.sessions ?? "known";
    sessionEvidenceByDay.set(key, sumEvidence(sessionEvidenceByDay.get(key), evidence));
  }
  for (const g of dailyAgg) {
    const k = toolDateKey(g._id);
    const s = sessionsPerDay.get(k) ?? new Set<string>();
    for (const id of g.sessionIds) s.add(id);
    sessionsPerDay.set(k, s);
  }
  dailyAgg.sort((a, b) =>
    a._id.date !== b._id.date
      ? a._id.date.localeCompare(b._id.date)
      : a._id.tool !== b._id.tool
        ? a._id.tool.localeCompare(b._id.tool)
        : a._id.model.localeCompare(b._id.model),
  );
  // Same convention as the v1 parsers: the per-day session count sits on the
  // FIRST model row of each (date, tool) only — consumers SUM sessions.
  const dailyRows: UsageRow[] = dailyAgg.map((g, i) => {
    const prev = dailyAgg[i - 1];
    const first = !prev || prev._id.date !== g._id.date || prev._id.tool !== g._id.tool;
    return {
      date: g._id.date,
      tool: g._id.tool,
      model: g._id.model,
      externalId,
      machineId: DERIVED_MACHINE_ID,
      inputTokens: g.inputTokens,
      outputTokens: g.outputTokens,
      cacheReadTokens: g.cacheReadTokens,
      cacheCreationTokens: g.cacheCreationTokens,
      requests: g.requests,
      sessions: first && sessionEvidenceByDay.get(toolDateKey(g._id)) === "known" ? sessionsPerDay.get(toolDateKey(g._id))?.size ?? 0 : null,
      fieldEvidence: { ...g.fieldEvidence, sessions: first ? sessionEvidenceByDay.get(toolDateKey(g._id)) ?? "unknown" : "unsupported" },
      dateBasis: g.dateBasis,
      source: "uploader",
    };
  });
  const daily = await upsertUsageRows(dailyRows);

  const freshDaily = new Set(
    dailyRows.map((r) => JSON.stringify([r.date, r.tool, canonicalizeModel(r.model)])),
  );
  const derivedDaily = await UsageDaily.find({
    ...match,
    machineId: DERIVED_MACHINE_ID,
    source: "uploader",
  })
    .select({ date: 1, tool: 1, model: 1 })
    .lean();
  const staleDaily = derivedDaily
    .filter((d) => !freshDaily.has(JSON.stringify([d.date, d.tool, d.model])))
    .map((d) => d._id);
  if (staleDaily.length > 0) await UsageDaily.deleteMany({ _id: { $in: staleDaily } });

  // ---- hourly ----
  const hourlyAgg = [...hourlyMap.values()].sort((a, b) =>
    a._id.hour !== b._id.hour
      ? a._id.hour.localeCompare(b._id.hour)
      : a._id.tool !== b._id.tool
        ? a._id.tool.localeCompare(b._id.tool)
        : a._id.model.localeCompare(b._id.model),
  );
  const hourlyRows: UsageHourlyRow[] = hourlyAgg.map((g) => ({
    hour: g._id.hour,
    tool: g._id.tool,
    model: g._id.model,
    externalId,
    machineId: DERIVED_MACHINE_ID,
    inputTokens: g.inputTokens,
    outputTokens: g.outputTokens,
    cacheReadTokens: g.cacheReadTokens,
    cacheCreationTokens: g.cacheCreationTokens,
    requests: g.requests,
    fieldEvidence: g.fieldEvidence,
    dateBasis: g.dateBasis,
    source: "uploader",
  }));
  const hourly = await upsertHourlyRows(hourlyRows);

  const freshHourly = new Set(
    hourlyRows.map((r) => JSON.stringify([r.hour, r.tool, canonicalizeModel(r.model)])),
  );
  const derivedHourly = await UsageHourly.find({
    externalId,
    machineId: DERIVED_MACHINE_ID,
    source: "uploader",
    $or: uniq.map(({ tool, date }) => ({ tool, hour: hourRange(date) })),
  })
    .select({ hour: 1, tool: 1, model: 1 })
    .lean();
  const staleHourly = derivedHourly
    .filter((d) => !freshHourly.has(JSON.stringify([d.hour, d.tool, d.model])))
    .map((d) => d._id);
  if (staleHourly.length > 0) await UsageHourly.deleteMany({ _id: { $in: staleHourly } });

  return { daily: daily.upserted, hourly: hourly.upserted, divertedLegacy };
}
