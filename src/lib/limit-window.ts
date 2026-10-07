import { createHash } from "node:crypto";
import { deviceLabels } from "@/lib/machine-id";

// Display label for a plan rate-limit window (limit snapshot `window`).
// Claude windows come from the usage API ("five_hour", "seven_day", ...);
// Codex windows are "codex_<window_minutes>m" from local rollout logs.
export function windowLabel(window: string): string {
  switch (window) {
    case "five_hour":
      return "5시간 창";
    case "seven_day":
      return "7일 창";
    case "seven_day_opus":
      return "7일 창 (Opus)";
    case "codex_300m":
      return "codex 5시간";
    case "codex_10080m":
      return "codex 주간";
  }
  const codex = /^codex_(\d+)m$/.exec(window);
  if (codex) return `codex ${Number(codex[1])}분`;
  return window;
}

// Codex snapshots carry organization "device:<tag>" so one member's devices on
// different plans stay apart (R23). tag = sha1(machineId)[0:8] since uploader
// PARSER_VERSION 3 (final-review F3); older uploaders sent the raw first 8
// chars of the id — both are matched.
const DEVICE_ORG = /^device:(.+)$/;
const deviceTag = (machineId: string) =>
  createHash("sha1").update(machineId).digest("hex").slice(0, 8);

// Display labels for snapshot organizations. Claude orgs (plan/team names) and
// "" pass through. A "device:" org never shows its id: with the member's
// machineIds it gets the same "기기 N" as the /me devices table (prefix
// match; "기기" when no device matches); without them the device orgs are
// numbered among themselves.
export function organizationLabels(
  organizations: string[],
  machineIds?: string[],
): Map<string, string> {
  const out = new Map<string, string>();
  const deviceOrgs = [...new Set(organizations.filter((o) => DEVICE_ORG.test(o)))].sort();
  const known = machineIds ? deviceLabels(machineIds) : null;
  const ids = machineIds ? [...new Set(machineIds.filter((m) => m !== ""))].sort() : [];
  deviceOrgs.forEach((org, i) => {
    const prefix = DEVICE_ORG.exec(org)![1];
    if (known) {
      const id = ids.find((m) => deviceTag(m) === prefix) ?? ids.find((m) => m.startsWith(prefix));
      out.set(org, (id && known.get(id)) || "기기");
    } else {
      out.set(org, `기기 ${i + 1}`);
    }
  });
  for (const o of organizations) if (!out.has(o)) out.set(o, o);
  return out;
}
