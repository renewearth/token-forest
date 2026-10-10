import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { collectRecords, manifest, SOURCE_TOOLS } from "./sources.mjs";
import { acquireReliableLock, bindOutboxOwner, stageRecords, readOutbox } from "./outbox.mjs";
import { sendReliable } from "./send.mjs";
import { deviceId } from "../lib/device-id.mjs";

const HELP = `Protocol 3 usage collection
  --reliable                 collect, persist and upload records (no v1/v2 fallback)
  --reliable-manifest        read-only JSON key/digest manifest; no config, credentials or state access
  --reliable-reconcile       read-only server comparison (needs --server and --token)
  --source-root <dir>        source home directory (defaults to current home)
  --opencode-db <file>       explicit read-only OpenCode SQLite file
  --codex-dir <dir>          additional Codex rollout/archived directory; repeatable
  --account <tool>=<id>      explicit logical source account namespace; repeatable
  --server <url> --token <token>  protocol 3 endpoint credentials
  --device-label <label>     optional device label for upload
  --dry-run                  alias for --reliable-manifest with --reliable
`;

function parse(argv) {
  const out = { mode: null, sourceRoot: homedir(), opencodeDbPath: null, codexDirs: [], accounts: {}, server: null, token: null, deviceLabel: null };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--reliable") out.mode ??= "upload";
    else if (flag === "--reliable-manifest" || flag === "--dry-run") out.mode = "manifest";
    else if (flag === "--reliable-reconcile") out.mode = "reconcile";
    else if (flag === "--help" || flag === "-h") out.mode = "help";
    else if (["--source-root", "--opencode-db", "--codex-dir", "--account", "--server", "--token", "--device-label"].includes(flag)) {
      const value = argv[++i];
      if (!value) throw new Error(`${flag} requires a value`);
      if (flag === "--source-root") out.sourceRoot = path.resolve(value);
      else if (flag === "--opencode-db") out.opencodeDbPath = path.resolve(value);
      else if (flag === "--codex-dir") out.codexDirs.push(path.resolve(value));
      else if (flag === "--server") out.server = value.replace(/\/+$/, "");
      else if (flag === "--token") out.token = value;
      else if (flag === "--device-label") out.deviceLabel = value;
      else {
        const sep = value.indexOf("=");
        const tool = value.slice(0, sep), id = value.slice(sep + 1);
        if (sep < 1 || !SOURCE_TOOLS.includes(tool) || !/^[A-Za-z0-9._:-]{1,128}$/.test(id)) throw new Error("invalid --account; use tool=opaque-id");
        out.accounts[tool] = id;
      }
    } else throw new Error(`unknown protocol3 argument: ${flag}`);
  }
  if (out.deviceLabel && out.deviceLabel.length > 32) throw new Error("device label exceeds 32 characters");
  return out;
}

async function uploadConfig(args) {
  let file = {};
  try { file = JSON.parse(await readFile(path.join(homedir(), ".config", "token-forest", "config.json"), "utf8")); }
  catch { /* CLI and environment are sufficient */ }
  return { serverUrl: args.server || process.env.TOKEN_FOREST_URL || file.serverUrl,
    token: args.token || process.env.TOKEN_FOREST_TOKEN || file.token,
    deviceLabel: args.deviceLabel || file.deviceLabel || null,
    accounts: { ...(file.reliableAccounts && typeof file.reliableAccounts === "object" ? file.reliableAccounts : {}), ...args.accounts } };
}

async function buildHash() {
  const names = ["records.mjs", "sources.mjs", "outbox.mjs", "send.mjs", "cli.mjs", "lock.py"];
  const hash = createHash("sha256");
  for (const name of names) hash.update(await readFile(new URL(name, import.meta.url)));
  return hash.digest("hex").slice(0, 32);
}

async function reconcile(serverUrl, token, expected) {
  const res = await fetch(`${serverUrl.replace(/\/+$/, "")}/api/ingest/records/reconcile`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ expected }),
  });
  if (!res.ok) throw new Error(`protocol3 reconcile HTTP ${res.status}`);
  return await res.json();
}

export async function runReliable(argv) {
  const args = parse(argv);
  if (args.mode === "help") { console.log(HELP); return; }
  if (!args.mode) throw new Error("select --reliable, --reliable-manifest or --reliable-reconcile");

  // Manifest performs no config read, device-id creation, cursor update, lock,
  // OAuth refresh, or network request. It contains no prompt/path/content.
  if (args.mode === "manifest") {
    const found = await collectRecords(args);
    console.log(JSON.stringify(manifest(found.records, found.health), null, 2));
    return;
  }

  const config = await uploadConfig(args);
  if (!config.serverUrl || !config.token) throw new Error("protocol3 requires a server URL and ingest token");
  if (args.mode === "reconcile") {
    const found = await collectRecords({ ...args, accounts: config.accounts });
    const items = manifest(found.records, found.health).records;
    const statuses = [];
    for (let i = 0; i < items.length; i += 1000) {
      statuses.push(await reconcile(config.serverUrl, config.token, items.slice(i, i + 1000).map(({ key, digest }) => ({ key, digest }))));
    }
    console.log(JSON.stringify({ protocolVersion: 3, expected: items.length, statuses, health: found.health }, null, 2));
    return;
  }

  const lock = await acquireReliableLock();
  if (!lock.acquired) throw new Error(`protocol3 run lock: ${lock.reason}`);
  const release = () => { void lock.release(); };
  process.once("exit", release);
  try {
    bindOutboxOwner({ serverUrl: config.serverUrl, token: config.token });
    const found = await collectRecords({ ...args, accounts: config.accounts });
    const staged = stageRecords(found.records);
    const pkg = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
    const result = await sendReliable({ serverUrl: config.serverUrl, token: config.token, health: found.health,
      device: { machineId: deviceId(), ...(config.deviceLabel ? { label: config.deviceLabel } : {}),
        uploaderVersion: pkg.version, buildHash: await buildHash() } });
    console.log(JSON.stringify({ protocolVersion: 3, scanned: found.records.length, staged: staged.added,
      acknowledged: result.removed, pending: readOutbox().entries.length, health: found.health }));
  } finally { await lock.release(); process.removeListener("exit", release); }
}
