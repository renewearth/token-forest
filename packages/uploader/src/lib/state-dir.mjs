// Where the uploader keeps its local state (device-id, cursor.json,
// claude-attr.json). Default ~/.token-forest; TOKEN_FOREST_STATE_DIR overrides
// it so integration checks never touch a real machine's state files. Resolved
// on every call (not at import) so a changed env/HOME takes effect.
import { homedir } from "node:os";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export function stateDir() {
  const fromEnv = (process.env.TOKEN_FOREST_STATE_DIR ?? "").trim();
  return fromEnv || path.join(homedir(), ".token-forest");
}

export function statePath(name) {
  return path.join(stateDir(), name);
}

// Write a small state file atomically (tmp + rename) so a crash or a
// concurrent run (SessionEnd hook + hourly schedule) never leaves a torn file.
export function writeStateFile(name, text) {
  const file = statePath(name);
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, file);
}
