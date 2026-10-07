// Stable pseudonymous device identity: a random UUID persisted OUTSIDE the
// uploader/ folder so a reinstall keeps it. Hostname is NEVER used or sent.
// Location: $TOKEN_FOREST_STATE_DIR/device-id (default ~/.token-forest).
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { statePath } from "./state-dir.mjs";

export function deviceId() {
  const ID_PATH = statePath("device-id");
  try {
    const existing = readFileSync(ID_PATH, "utf8").trim();
    if (existing) return existing;
  } catch {
    // not created yet
  }
  const id = randomUUID();
  try {
    mkdirSync(path.dirname(ID_PATH), { recursive: true });
    // Exclusive create so concurrent runs (SessionEnd + hourly launchd) can't
    // clobber each other; the loser re-reads the winner's id below.
    writeFileSync(ID_PATH, id + "\n", { mode: 0o600, flag: "wx" });
    return id;
  } catch (err) {
    if (err && err.code === "EEXIST") {
      try {
        const won = readFileSync(ID_PATH, "utf8").trim();
        if (won) return won;
      } catch {
        // fall through to ephemeral
      }
    }
    console.error(`warn: could not persist device-id (${err.message}); using ephemeral id`);
    return id;
  }
}

// Short device tag for ids that must tell this device apart without carrying
// the machineId itself: sha1(machineId) → first 8 hex chars. A --machine-id /
// TOKEN_FOREST_MACHINE_ID override can be a hostname, so raw machineId chars
// never go into a sessionId or organization (final-review F3). Used by the
// grok fallback sessionId and the Codex limit organization. "" without an id.
export function deviceTag(machineId) {
  if (typeof machineId !== "string" || !machineId) return "";
  return createHash("sha1").update(machineId).digest("hex").slice(0, 8);
}
