import { createHash } from "node:crypto";

// Device identity is pseudonymous: an opaque per-machine token, never a hostname.
// Same rule is shared by the ingest backstop and the one-time migration.

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Our produced hash token shape: "dev_" + exactly 12 hex. A real hostname that
// merely starts "dev_" (e.g. "dev_myhost") must NOT match, so it gets hashed.
const DEV_TOKEN_RE = /^dev_[0-9a-f]{12}$/;

// Already opaque: a client-generated UUID, or a hashed "dev_…" token.
export function isOpaqueMachineId(v: string): boolean {
  return UUID_RE.test(v) || DEV_TOKEN_RE.test(v);
}

// Normalize any machineId to a non-identifying form. "" (pollers/legacy) stays "".
// Opaque values pass through (idempotent). A hostname is hashed to "dev_"+12 hex.
export function anonymizeMachineId(raw: string): string {
  if (raw === "" || isOpaqueMachineId(raw)) return raw;
  return "dev_" + createHash("sha256").update(raw).digest("hex").slice(0, 12);
}

export { deviceLabels } from "./device-labels";
