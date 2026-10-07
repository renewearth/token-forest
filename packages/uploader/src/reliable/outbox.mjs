import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, fsyncSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { recordKey, recordDigest } from "./records.mjs";
import { statePath } from "../lib/state-dir.mjs";

const OUTBOX = "reliable-outbox.json";
const LOCK = "reliable.lock";
const RECEIPTS = "reliable-receipts.json";
const OWNER = "reliable-owner.json";

function readJson(name, fallback) {
  try { return JSON.parse(readFileSync(statePath(name), "utf8")); }
  catch (err) { if (err?.code === "ENOENT") return fallback; throw err; }
}

function writeAtomic(name, object) {
  const file = statePath(name);
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = openSync(tmp, "wx", 0o600);
    writeFileSync(fd, JSON.stringify(object) + "\n");
    fsyncSync(fd);
    closeSync(fd); fd = null;
    renameSync(tmp, file);
    try { const dir = openSync(path.dirname(file), "r"); fsyncSync(dir); closeSync(dir); } catch { /* unsupported directory fsync */ }
  } finally {
    if (fd !== null && fd !== undefined) closeSync(fd);
    try { unlinkSync(tmp); } catch { /* renamed or absent */ }
  }
}

// Python's fcntl.flock is released by the kernel when the helper exits. Its
// stdin is a pipe owned by this process: normal release closes it, and SIGKILL
// or reboot closes it automatically. The on-disk file is never unlinked, so
// there is no stale-file takeover race or recovery directory to strand.
export async function acquireReliableLock() {
  const file = statePath(LOCK);
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const helper = fileURLToPath(new URL("./lock.py", import.meta.url));
  const child = spawn("python3", [helper, file], { stdio: ["pipe", "pipe", "pipe"] });
  const result = await new Promise((resolve, reject) => {
    let reply = "", done = false;
    const timer = setTimeout(() => finish(new Error("protocol3 lock helper timeout")), 5000);
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (value instanceof Error) reject(value);
      else resolve(value);
    };
    child.once("error", () => finish(new Error("protocol3 Python lock helper unavailable")));
    child.once("exit", () => finish(new Error("protocol3 lock helper exited before handshake")));
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      reply += chunk;
      if (reply.includes("\n")) finish(reply.slice(0, reply.indexOf("\n")).trim());
    });
  });
  if (result === "held") return { acquired: false, reason: "already_running" };
  if (result !== "acquired") { child.stdin.end(); throw new Error("protocol3 lock helper invalid handshake"); }
  let released = false;
  child.once("exit", () => {
    if (!released) {
      console.error("protocol3 lock helper exited unexpectedly; stopping upload");
      process.exit(1);
    }
  });
  return { acquired: true, async release() {
    if (released) return;
    released = true;
    child.stdin.end();
    if (child.exitCode === null) await new Promise((resolve) => child.once("exit", resolve));
  } };
}

function ownerFingerprint(serverUrl, token) {
  const url = new URL(serverUrl);
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new Error("invalid protocol3 server URL");
  const destination = url.origin + url.pathname.replace(/\/+$/, "");
  return createHash("sha256").update(JSON.stringify([destination, token])).digest("hex");
}

// Persistent binding prevents a pending payload from being uploaded under a
// different member after token or destination changes. No credential is saved.
// The binding is never auto-migrated, even if the outbox is currently empty.
export function bindOutboxOwner({ serverUrl, token }) {
  const fingerprint = ownerFingerprint(serverUrl, token);
  const current = readJson(OWNER, null);
  if (current) {
    if (current.version !== 1 || current.fingerprint !== fingerprint)
      throw new Error("protocol3 destination or credential changed; outbox owner review required");
    return;
  }
  if (readOutbox().entries.length > 0)
    throw new Error("protocol3 pending outbox has no owner binding; manual review required");
  writeAtomic(OWNER, { version: 1, fingerprint });
}

export function readOutbox() {
  const data = readJson(OUTBOX, { version: 1, entries: [] });
  if (data.version !== 1 || !Array.isArray(data.entries)) throw new Error("invalid reliable outbox");
  return data;
}

export function readReceiptStatuses() {
  const data = readJson(RECEIPTS, { version: 1, entries: [] });
  if (data.version !== 1 || !Array.isArray(data.entries)) throw new Error("invalid reliable receipts");
  const latest = new Map();
  for (const entry of data.entries) latest.set(JSON.stringify([entry.key, entry.digest]), entry.status);
  return latest;
}

export function stageRecords(records) {
  if (!readJson(OWNER, null)) throw new Error("protocol3 outbox has no owner binding");
  const data = readOutbox();
  const seen = new Set(data.entries.map((e) => JSON.stringify([e.key, e.digest])));
  const receipts = readReceiptStatuses();
  let added = 0;
  for (const record of records) {
    const key = recordKey(record), digest = recordDigest(record);
    const id = JSON.stringify([key, digest]);
    if (seen.has(id) || ["stored", "unchanged", "superseded"].includes(receipts.get(id))) continue;
    data.entries.push({ key, digest, record });
    seen.add(id); added++;
  }
  if (added) writeAtomic(OUTBOX, data);
  return { added, pending: data.entries.length };
}

export function acknowledgeExact(acks) {
  const data = readOutbox();
  const receipts = readJson(RECEIPTS, { version: 1, entries: [] });
  const known = new Set(data.entries.map((e) => JSON.stringify([e.key, e.digest])));
  const remove = new Set();
  for (const ack of acks) {
    const id = JSON.stringify([ack?.key, ack?.digest]);
    if (!known.has(id)) continue;
    if (!["stored", "unchanged", "superseded", "conflict", "rejected"].includes(ack.status)) continue;
    receipts.entries.push({ key: ack.key, digest: ack.digest, status: ack.status,
      ...(ack.reasonCode ? { reasonCode: ack.reasonCode } : {}),
      ...(ack.currentDigest ? { currentDigest: ack.currentDigest } : {}) });
    if (["stored", "unchanged", "superseded"].includes(ack.status)) remove.add(id);
  }
  // Persist the receipt before clearing the outbox. A crash between writes
  // causes a harmless resend, rather than losing an unacknowledged record.
  if (acks.length) writeAtomic(RECEIPTS, receipts);
  data.entries = data.entries.filter((e) => !remove.has(JSON.stringify([e.key, e.digest])));
  if (remove.size) writeAtomic(OUTBOX, data);
  return { removed: remove.size, pending: data.entries.length,
    actionable: data.entries.filter((e) => !remove.has(JSON.stringify([e.key, e.digest]))).length };
}
