import { connectDb, UsageDaily } from "@/lib/db";
import { isoDaysAgo } from "@/lib/date";
import { ACTIVE_USER_EXPR, TOKENS_EXPR } from "@/lib/queries";
import { claimOnce, releaseClaim } from "@/lib/cron";

interface ToolWeek {
  tool: string;
  tokens: number; // input + output (cache excluded — same as the dashboard)
  requests: number;
  sessions: number;
  activeUsers: number;
}

// [fromDate, toDateExclusive)
async function toolTotals(
  fromDate: string,
  toDateExclusive: string,
): Promise<ToolWeek[]> {
  await connectDb();
  const rows = await UsageDaily.aggregate([
    { $match: { date: { $gte: fromDate, $lt: toDateExclusive } } },
    {
      $group: {
        _id: "$tool",
        tokens: { $sum: TOKENS_EXPR },
        requests: { $sum: { $ifNull: ["$requests", 0] } },
        sessions: { $sum: { $ifNull: ["$sessions", 0] } },
        users: { $addToSet: ACTIVE_USER_EXPR },
      },
    },
  ]);
  return rows.map((r) => ({
    tool: r._id as string,
    tokens: r.tokens,
    requests: r.requests,
    sessions: r.sessions,
    activeUsers: r.users.length,
  }));
}

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

function delta(current: number, previous: number): string {
  if (previous === 0) return current > 0 ? "(new)" : "";
  const pct = Math.round(((current - previous) / previous) * 100);
  return `(${pct >= 0 ? "+" : ""}${pct}% WoW)`;
}

// Weekly summary text: trailing 7 full days vs the 7 before them.
export async function buildWeeklyReport(): Promise<string> {
  const today = isoDaysAgo(0);
  const weekAgo = isoDaysAgo(7);
  const twoWeeksAgo = isoDaysAgo(14);
  const [current, previousList] = await Promise.all([
    toolTotals(weekAgo, today),
    toolTotals(twoWeeksAgo, weekAgo),
  ]);
  const previous = new Map(previousList.map((t) => [t.tool, t]));

  const lines = [
    `*token-forest 주간 리포트* (${weekAgo} ~ ${isoDaysAgo(1)})`,
    "",
  ];
  if (current.length === 0) {
    lines.push("이번 주 수집된 사용량 데이터가 없습니다.");
    return lines.join("\n");
  }
  for (const t of current.sort((a, b) => b.tokens - a.tokens)) {
    const prev = previous.get(t.tool);
    const parts = [`활성 ${t.activeUsers}명`];
    if (t.tokens > 0)
      parts.push(`토큰 ${fmt(t.tokens)} ${delta(t.tokens, prev?.tokens ?? 0)}`);
    if (t.requests > 0)
      parts.push(
        `요청 ${fmt(t.requests)} ${delta(t.requests, prev?.requests ?? 0)}`,
      );
    if (t.sessions > 0) parts.push(`세션 ${fmt(t.sessions)}`);
    lines.push(`• *${t.tool}* — ${parts.join(" · ").trim()}`);
  }
  const [overall] = await UsageDaily.aggregate([
    { $match: { date: { $gte: weekAgo, $lt: today } } },
    { $group: { _id: null, users: { $addToSet: ACTIVE_USER_EXPR } } },
  ]);
  lines.push("", `전체 주간 활성 사용자: ${overall?.users?.length ?? 0}명`);
  return lines.join("\n");
}

export async function sendWeeklyReport(): Promise<void> {
  const webhook = process.env.SLACK_WEBHOOK_URL;
  if (!webhook) throw new Error("SLACK_WEBHOOK_URL env var is not set");

  // The weekly cron is scheduled in every running server instance, so without
  // a cross-instance guard the report goes out once per instance (observed: 3x
  // on 2026-08-17). Claim the week atomically; only the winner sends. Keyed by
  // the report's own week-start so a re-send for the same week is suppressed
  // regardless of how many instances fire.
  const weekStart = isoDaysAgo(7);
  const key = `weekly-report:${weekStart}`;
  if (!(await claimOnce(key))) {
    console.log(`[slack] weekly report ${weekStart} already sent — skipping`);
    return;
  }

  try {
    const text = await buildWeeklyReport();
    const res = await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) {
      throw new Error(`Slack webhook failed: ${res.status} ${await res.text()}`);
    }
  } catch (err) {
    // The send failed — release the claim so a later run can retry this week.
    await releaseClaim(key).catch(() => {});
    throw err;
  }
}

// Onboarding wizard: a member uses a tool we have no connector for (e.g.
// OpenCode). Nudge the admin channel so the tool gets evaluated.
export async function sendConnectorRequest(
  tool: string,
  memberName: string,
  memberEmail: string,
): Promise<void> {
  const webhook = process.env.SLACK_WEBHOOK_URL;
  if (!webhook) throw new Error("SLACK_WEBHOOK_URL env var is not set");
  // Member-supplied strings: escape Slack control characters so nobody can
  // smuggle <!channel> pings or forge extra lines into the admin message.
  const esc = (s: string) =>
    s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/[\r\n]+/g, " ");
  const text = `:hammer_and_wrench: *커넥터 추가 요청* — \`${esc(tool)}\`\n요청자: ${esc(memberName)} (${memberEmail})\n(자동 수집 미지원 도구 · 온보딩 마법사에서 접수)`;
  const res = await fetch(webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) {
    throw new Error(`Slack webhook failed: ${res.status} ${await res.text()}`);
  }
}

// A member explicitly shared their daily digest — post it to the team channel.
// `date` is the summarized day, "YYYY-MM-DD".
export async function sendDigest(
  memberName: string,
  date: string,
  content: string,
): Promise<void> {
  const webhook = process.env.SLACK_WEBHOOK_URL;
  if (!webhook) throw new Error("SLACK_WEBHOOK_URL env var is not set");
  // The content is member-approved, but escape Slack control characters anyway
  // so a digest can't smuggle <!channel> pings. Unlike sendConnectorRequest's
  // esc, newlines are preserved — a digest is multi-line by design.
  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const [, m, d] = date.split("-");
  const monthDay = `${Number(m)}/${Number(d)}`; // "2026-07-18" -> "7/18"
  const name = esc(memberName).replace(/[\r\n]+/g, " ");
  // Slack renders mrkdwn (*bold*), not standard markdown (**bold**) — a
  // member may have typed markdown while editing the draft, so convert.
  const mrkdwn = esc(content).replace(/\*\*([^*\n]+)\*\*/g, "*$1*");
  const text = `📝 *${name}의 ${monthDay} 작업 다이제스트*\n${mrkdwn}`;
  const res = await fetch(webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) {
    throw new Error(`Slack webhook failed: ${res.status} ${await res.text()}`);
  }
}
