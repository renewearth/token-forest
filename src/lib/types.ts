import { z } from "zod";

export const fieldEvidenceSchema = z.object({
  inputTokens: z.enum(["known", "unknown", "unsupported"]).optional(),
  outputTokens: z.enum(["known", "unknown", "unsupported"]).optional(),
  cacheReadTokens: z.enum(["known", "unknown", "unsupported"]).optional(),
  cacheCreationTokens: z.enum(["known", "unknown", "unsupported"]).optional(),
  requests: z.enum(["known", "unknown", "unsupported"]).optional(),
  sessions: z.enum(["known", "unknown", "unsupported"]).optional(),
});
export type FieldEvidence = z.infer<typeof fieldEvidenceSchema>;
export const dateBasisSchema = z.enum(["KST", "UTC", "미확인"]);
export type DateBasis = z.infer<typeof dateBasisSchema>;

// The single unified row format. Every ingestion path — server-side pollers,
// the local uploader CLI, manual entry — produces UsageRow[].
// Values are daily totals per (date, tool, model, externalId): upserts replace.
export const usageRowSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD"),
  tool: z.string().min(1),
  model: z.string().default(""),
  // Tool-native user identifier (email, user_id, github username, ...)
  externalId: z.string().min(1),
  // Distinguishes uploads from different machines of the same member so their
  // daily totals add instead of overwriting. "" for server-side pollers.
  machineId: z.string().max(64).optional(),
  inputTokens: z.number().int().nonnegative().nullish(),
  outputTokens: z.number().int().nonnegative().nullish(),
  cacheReadTokens: z.number().int().nonnegative().nullish(),
  cacheCreationTokens: z.number().int().nonnegative().nullish(),
  requests: z.number().int().nonnegative().nullish(),
  sessions: z.number().int().nonnegative().nullish(),
  fieldEvidence: fieldEvidenceSchema.optional(),
  dateBasis: dateBasisSchema.optional(),
  costEstimateCents: z.number().nonnegative().nullish(),
  source: z.enum(["poller", "uploader", "manual"]),
});

// Legacy connector objects may still carry provider metadata. It is never
// accepted by the public ingest schema or persisted by upsertUsageRows.
export type UsageRow = z.infer<typeof usageRowSchema> & { raw?: unknown };

// Hour-grained rows for the additive usage_hourly collection. Same shape as a
// usage row minus daily-only fields, keyed by an hour string instead of date.
export const usageHourlyRowSchema = z.object({
  hour: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}$/, "hour must be YYYY-MM-DDTHH"),
  tool: z.string().min(1),
  model: z.string().default(""),
  externalId: z.string().min(1),
  machineId: z.string().max(64).optional(),
  inputTokens: z.number().int().nonnegative().nullish(),
  outputTokens: z.number().int().nonnegative().nullish(),
  cacheReadTokens: z.number().int().nonnegative().nullish(),
  cacheCreationTokens: z.number().int().nonnegative().nullish(),
  requests: z.number().int().nonnegative().nullish(),
  fieldEvidence: fieldEvidenceSchema.optional(),
  dateBasis: dateBasisSchema.optional(),
  source: z.enum(["poller", "uploader", "manual"]),
});

export type UsageHourlyRow = z.infer<typeof usageHourlyRowSchema>;

// Collection v2 session-grained row (uploader → usagesessions). Key =
// (tool, sessionId, hour, model); externalId is never accepted from the client
// — the server forces the authenticated member's id. Values MAX-merge across
// machines; a higher parserVersion overwrites (src/lib/sessions.ts).
const sessionCount = z.number().int().nonnegative().nullish().default(null);
export const usageSessionRowSchema = z.object({
  tool: z.string().min(1).max(40),
  // Tool-native session id with a tool prefix, e.g. "claude_code:<uuid>".
  sessionId: z.string().min(1).max(200),
  // KST hour bucket (uploader convention); date = hour.slice(0, 10).
  hour: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}$/, "hour must be YYYY-MM-DDTHH"),
  model: z.string().max(200).default(""),
  provider: z.string().max(60).optional(),
  inputTokens: sessionCount,
  outputTokens: sessionCount,
  cacheReadTokens: sessionCount,
  cacheCreationTokens: sessionCount,
  requests: sessionCount,
  fieldEvidence: fieldEvidenceSchema.optional(),
  dateBasis: dateBasisSchema.optional(),
  parserVersion: z.number().int().min(1),
  machineId: z.string().max(64).optional(),
});

export type UsageSessionRow = z.infer<typeof usageSessionRowSchema>;

// Diagnostics (health, device) are LOSSY on purpose: a bad diagnostic field
// must never 400 the whole upload (the usage in the same request would be
// lost every cycle, with no v1 fallback — path is health/device, not rows).
// Over-long strings are clipped, malformed health items dropped, an unusable
// device ignored. Usage fields (rows, hourly, sessions) stay strict.

// Clip to at most n UTF-16 units without splitting a surrogate pair.
export function clip(s: string, n: number): string {
  if (s.length <= n) return s;
  const code = s.charCodeAt(n - 1);
  return s.slice(0, code >= 0xd800 && code <= 0xdbff ? n - 1 : n);
}

// Per-parser health reported by a v2 uploader run (spec §3.3 "파서 고장 감지").
// `error` = why a parser was skipped (e.g. opencode DB locked) — Ruling R3
// limits (parser ≤40, error ≤200) are enforced by clipping, not rejection.
const healthCount = z.number().int().nonnegative();
export const parserHealthSchema = z.object({
  parser: z
    .string()
    .trim()
    .min(1)
    .transform((s) => clip(s, 40)),
  filesScanned: healthCount,
  linesUnrecognized: healthCount,
  sessionsEmitted: healthCount,
  // A non-string error drops just the field, not the reading.
  error: z
    .string()
    .transform((s) => clip(s, 200))
    .optional()
    .catch(undefined),
});
export type ParserHealth = z.infer<typeof parserHealthSchema>;
export const MAX_HEALTH_ITEMS = 50;

// Any value → the first MAX_HEALTH_ITEMS well-formed readings (non-array → []).
const lossyHealth = z.unknown().transform((v): ParserHealth[] => {
  if (!Array.isArray(v)) return [];
  const out: ParserHealth[] = [];
  for (const item of v) {
    if (out.length >= MAX_HEALTH_ITEMS) break;
    const r = parserHealthSchema.safeParse(item);
    if (r.success) out.push(r.data);
  }
  return out;
});

// The uploading machine. machineId is the pseudonymous device token (the
// server re-anonymizes it anyway) and must be usable — it is the Device key.
// label is the member's own optional name for it, from the uploader config
// only — never auto-filled from the hostname; clipped to 32. A non-string
// label is ignored.
export const deviceInfoSchema = z.object({
  machineId: z.string().trim().min(1).max(64),
  label: z
    .string()
    .transform((s) => clip(s.trim(), 32).trim())
    .optional()
    .catch(undefined),
  uploaderVersion: z
    .string()
    .trim()
    .min(1)
    .transform((s) => clip(s, 40)),
});
export type DeviceInfo = z.infer<typeof deviceInfoSchema>;

// Any value → a usable DeviceInfo, or undefined (device ignored, usage kept).
const lossyDevice = z.unknown().transform((v): DeviceInfo | undefined => {
  if (v === undefined) return undefined;
  const r = deviceInfoSchema.safeParse(v);
  return r.success ? r.data : undefined;
});

// Ingest callers are authenticated as a member; externalId is always derived
// from that member (a supplied value is ignored — see src/lib/ingest.ts).
// v1 (old uploaders): `rows` (≥1) + optional `hourly` (heatmap only) — still
// valid unchanged. v2: `sessions` (session-grained, collection v2) plus
// optional parser `health` and `device`. A payload with `device` and no
// rows/sessions is a valid heartbeat (Ruling R12: refreshes the Device doc,
// writes no usage; an unusable device counts as absent). Without device, at
// least one of rows/sessions must be non-empty; that issue sits at path
// ["rows"] like the old `rows.min(1)`, so
// the uploader's v1-fallback trigger (Ruling R2: path[0] === "rows") reads
// both servers the same way.
export const ingestPayloadSchema = z
  .object({
    rows: z
      .array(usageRowSchema.extend({ externalId: z.string().optional() }))
      .max(10_000)
      .optional(),
    hourly: z
      .array(usageHourlyRowSchema.extend({ externalId: z.string().optional() }))
      .max(20_000)
      .optional(),
    // One request must carry every since-window bucket of a session (R8
    // contract of upsertSessionRows) — hence the generous cap.
    sessions: z.array(usageSessionRowSchema).max(50_000).optional(),
    health: lossyHealth.optional(),
    device: lossyDevice.optional(),
  })
  .refine(
    (p) =>
      (p.rows?.length ?? 0) > 0 || (p.sessions?.length ?? 0) > 0 || p.device !== undefined,
    {
      message: "rows or sessions must contain at least one row (or send device as a heartbeat)",
      path: ["rows"],
    },
  );
export type IngestPayload = z.infer<typeof ingestPayloadSchema>;

// Plan-limit snapshot for one Claude account window. Posted to /api/limits by
// the uploader; the member is the authenticated caller.
export const limitSnapshotSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD"),
  accountEmail: z.string().min(1),
  // One email can hold several plans (personal Max + Team seat); the login's
  // organization tells them apart. "" for uploaders predating this field.
  organization: z.string().optional(),
  window: z.string().min(1),
  utilizationPct: z.number().nonnegative(),
  subscriptionType: z.string().nullish(),
  rateLimitTier: z.string().nullish(),
  resetsAt: z.string().nullish(),
  raw: z.unknown().optional(),
});

export type LimitSnapshotInput = z.infer<typeof limitSnapshotSchema>;

export const limitsPayloadSchema = z.object({
  snapshots: z.array(limitSnapshotSchema).min(1).max(200),
});

// Daily digest draft posted to /api/digest by the uploader. The member is the
// authenticated caller; the server only accepts it while the document is still
// an unedited draft (human edits/resolutions are immutable to the uploader).
export const digestPayloadSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  content: z.string().min(1).max(4000),
  materials: z.string().max(8000).default(""),
  touchedFiles: z
    .array(
      z.object({
        repo: z.string().min(1).max(200),
        files: z.array(z.string().max(500)).max(100),
      }),
    )
    .max(20)
    .default([]),
  // Machines whose material is included (multi-machine merge bookkeeping).
  machines: z.array(z.string().min(1).max(64)).max(8).default([]),
});
export type DigestPayload = z.infer<typeof digestPayloadSchema>;
