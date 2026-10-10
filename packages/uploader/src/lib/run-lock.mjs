// One uploader run at a time per state dir (Ruling R21). The hourly schedule,
// the SessionEnd hook and a manual run can overlap; two runs racing on
// cursor.json / claude-attr.json could flip a sticky pin (double count).
//   $STATE_DIR/run.lock = { pid, at } — created with O_EXCL ("wx").
// A lock is stale when its pid is not alive (taken over at once) or it is
// older than STALE_LOCK_MS (a hung/unknown run). Takeover re-reads the lock
// and only removes it if it is still the exact content judged stale, then
// re-creates it with "wx" — if another run won either step, we back off as
// "held". (A sliver remains between that re-read and the unlink; two runs
// taking over the same stale lock inside it is accepted as negligible.)
// The lock is removed on process exit, but only if it is still ours.
import { mkdirSync, readFileSync, unlinkSync, writeFileSync, statSync } from "node:fs";
import path from "node:path";
import { statePath } from "./state-dir.mjs";

export const STALE_LOCK_MS = 2 * 3600 * 1000;
const FILE = "run.lock";

function tryCreate(file, content) {
  try {
    writeFileSync(file, content, { flag: "wx", mode: 0o600 });
    return true;
  } catch (err) {
    if (err && err.code === "EEXIST") return false;
    throw err;
  }
}

function readRaw(file) {
  try {
    return readFileSync(file, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") return null;
    throw err;
  }
}

// false only when the pid certainly does not exist (ESRCH). EPERM = alive
// under another user; a missing/invalid pid is unknown → treated as alive
// (the age rule still applies).
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code !== "ESRCH";
  }
}

function isStale(file, raw, now) {
  let info = null;
  try {
    info = JSON.parse(raw);
  } catch {
    // torn/garbage content → judge by mtime below
  }
  if (info && !pidAlive(info.pid)) return true;
  let at = Date.parse(info?.at);
  if (Number.isNaN(at)) {
    try {
      at = statSync(file).mtimeMs;
    } catch {
      return true; // vanished meanwhile
    }
  }
  return now - at > STALE_LOCK_MS;
}

// Replace the lock only if it still holds `judgedRaw` (or is already gone).
// Exported for tests.
export function takeOverIfUnchanged(file, judgedRaw, content) {
  const current = readRaw(file);
  if (current !== null) {
    if (current !== judgedRaw) return false; // someone else took it
    try {
      unlinkSync(file);
    } catch {
      // already gone
    }
  }
  return tryCreate(file, content);
}

// → { acquired: true, release } or { acquired: false }. `now` is injectable
// for tests. Throws only on unexpected fs errors (not on "held").
export function acquireRunLock(now = Date.now()) {
  const file = statePath(FILE);
  mkdirSync(path.dirname(file), { recursive: true });
  const content = JSON.stringify({ pid: process.pid, at: new Date(now).toISOString() }) + "\n";
  let ok = tryCreate(file, content);
  if (!ok) {
    const raw = readRaw(file);
    if (raw === null) ok = tryCreate(file, content);
    else if (isStale(file, raw, now)) ok = takeOverIfUnchanged(file, raw, content);
  }
  if (!ok) return { acquired: false };
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try {
      if (readFileSync(file, "utf8") === content) unlinkSync(file);
    } catch {
      // gone or unreadable — nothing to release
    }
  };
  return { acquired: true, release };
}
