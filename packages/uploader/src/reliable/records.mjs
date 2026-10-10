import { createHash } from "node:crypto";

export const METRIC_FIELDS = Object.freeze([
  "inputTokens", "outputTokens", "cacheReadTokens", "cacheCreationTokens", "requests",
]);

export const RECORD_FIELDS = Object.freeze([
  "tool", "accountId", "recordId", "sessionId", "kind", "occurredAt", "model",
  "provider", "parserVersion", "revision", "completeness", "identityQuality",
  ...METRIC_FIELDS, "fieldEvidence",
]);

// Member comes from authentication; device is provenance. Neither belongs in
// the source-record key, so a copied log or a renamed host retains its key.
export function recordKey(record) {
  return JSON.stringify([record.tool, record.accountId, record.recordId]);
}

// The wire digest covers only the agreed Record semantics. Every optional
// metric has an explicit null and every omitted evidence flag is unknown.
// Validation of provided values happens at the API boundary before this step.
export function normalizeRecordSemantics(record) {
  const out = {};
  for (const field of RECORD_FIELDS) {
    if (field === "fieldEvidence") {
      out.fieldEvidence = {};
      for (const metric of METRIC_FIELDS) {
        out.fieldEvidence[metric] = record.fieldEvidence?.[metric] ?? "unknown";
      }
    } else if (field === "provider" || METRIC_FIELDS.includes(field)) {
      out[field] = record[field] ?? null;
    } else {
      out[field] = record[field];
    }
  }
  return out;
}

export function canonicalJson(value) {
  if (value === null || typeof value !== "object") {
    const json = JSON.stringify(value);
    if (json === undefined) throw new TypeError("undefined is not canonical JSON");
    return json;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

export function recordDigest(record) {
  return createHash("sha256").update(canonicalJson(normalizeRecordSemantics(record))).digest("hex");
}
