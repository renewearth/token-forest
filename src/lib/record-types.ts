import { z } from "zod";
import { METRIC_FIELDS, type UsageRecord } from "../../packages/protocol/records.mjs";

const opaque = z.string().min(1).max(256).refine((v) => !/[\\/\r\n\0]/.test(v), "not opaque");
const counter = z.number().int().nonnegative().safe().nullable();
const evidence = z.enum(["known", "unknown", "unsupported"]);
const fieldEvidence = z.object({
  inputTokens: evidence.optional(), outputTokens: evidence.optional(),
  cacheReadTokens: evidence.optional(), cacheCreationTokens: evidence.optional(),
  requests: evidence.optional(),
}).strict();
export const recordSchema = z.object({
  tool: z.enum(["claude_code", "codex", "gemini", "grok", "opencode"]),
  accountId: opaque, recordId: opaque, sessionId: opaque,
  kind: z.enum(["event", "cumulative"]),
  occurredAt: z.iso.datetime({ offset: true }),
  model: z.string().max(256), provider: z.string().max(256).nullable().optional(),
  parserVersion: z.number().int().positive().safe(), revision: z.number().int().nonnegative().safe(),
  completeness: z.enum(["partial", "final"]),
  identityQuality: z.enum(["native", "derived", "unverified"]),
  inputTokens: counter.optional(), outputTokens: counter.optional(),
  cacheReadTokens: counter.optional(), cacheCreationTokens: counter.optional(),
  requests: counter.optional(), fieldEvidence: fieldEvidence.optional(),
}).strict().superRefine((v, ctx) => {
  if (Number.isNaN(Date.parse(v.occurredAt))) ctx.addIssue({ code: "custom", message: "invalid timestamp" });
  for (const field of METRIC_FIELDS) {
    const value = v[field];
    const ev = v.fieldEvidence?.[field] ?? "unknown";
    if (value !== null && value !== undefined && ev !== "known")
      ctx.addIssue({ code: "custom", message: `${field} lacks known evidence` });
    if ((value === null || value === undefined) && ev === "known")
      ctx.addIssue({ code: "custom", message: `${field} lacks value` });
  }
});

export const deviceSchema = z.object({
  machineId: z.string().min(1).max(256), label: z.string().max(256).optional(),
  uploaderVersion: z.string().min(1).max(128), buildHash: z.string().max(128).optional(),
}).strict();

const parserHealthSchema = z.object({
  parser: z.enum(["claude_code", "codex", "gemini", "grok", "opencode"]),
  accountId: opaque.optional(),
  namespaceConfigured: z.boolean().optional(),
  namespaceVerified: z.boolean().optional(),
  filesScanned: z.number().int().nonnegative().safe(),
  linesUnrecognized: z.number().int().nonnegative().safe(),
  readErrors: z.number().int().nonnegative().safe(),
  records: z.number().int().nonnegative().safe(),
  locationsChecked: z.number().int().nonnegative().safe().optional(),
  locationsPresent: z.number().int().nonnegative().safe().optional(),
  error: z.enum(["sqlite_unavailable", "sqlite_unreadable", "sqlite_schema_mismatch", "parser_failed"]).optional(),
}).strict();
export const recordHealthSchema = z.union([z.array(parserHealthSchema).max(20), z.object({
  pending: z.number().int().nonnegative().safe().optional(),
  rejected: z.number().int().nonnegative().safe().optional(),
  readErrors: z.number().int().nonnegative().safe().optional(),
  lastRunAt: z.iso.datetime({ offset: true }).optional(),
  status: z.enum(["ok", "partial", "error", "unsupported", "disconnected"]).optional(),
  sources: z.array(parserHealthSchema).max(20).optional(),
}).strict()]);

export const ingestRecordsSchema = z.object({
  protocolVersion: z.literal(3), device: deviceSchema,
  records: z.array(z.unknown()).max(1000), health: recordHealthSchema.optional(),
}).strict();

export const reconcileSchema = z.object({
  expected: z.array(z.object({ key: z.string().max(1024), digest: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).max(1000),
}).strict();

export type RecordSemantics = Required<UsageRecord>;
