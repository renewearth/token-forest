import { UsageLink as Link } from "@/app/_components/UsageLink";
import { Types } from "mongoose";
import { connectDb, UsageDaily } from "@/lib/db";
import { getViewer } from "@/lib/auth";
import { rangeForDays } from "@/app/_lib/ui";

// Slim nudge shown to a signed-in member whose Claude Code usage isn't flowing
// yet — the one connection that needs action on their own machine. Renders null
// for anonymous/unknown viewers and once Claude Code is connected.
export default async function Banner() {
  const viewer = await getViewer();
  if (viewer.status !== "member") return null;

  await connectDb();
  const r14 = rangeForDays(14);
  const [claudeCode, anyUsage] = await Promise.all([
    UsageDaily.findOne({
      tool: "claude_code",
      externalId: viewer.member.email,
      date: { $gte: r14.from },
    }).lean(),
    UsageDaily.findOne({
      memberId: new Types.ObjectId(viewer.member.id),
    }).lean(),
  ]);

  // Don't nag a brand-new member with zero data of any kind — the /me hub itself
  // is the right first stop for them. Only prompt once some usage exists but
  // Claude Code specifically is still missing.
  if (claudeCode || !anyUsage) return null;

  return (
    <div className="border-b border-[var(--series-3)]/40 bg-[var(--series-3)]/10">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-3 gap-y-1 px-6 py-2 text-sm">
        <span className="text-[var(--text-secondary)]">
          Claude Code 사용량이 아직 연결되지 않았어요.
        </span>
        <Link
          href="/me"
          className="font-medium text-[var(--series-1)] underline underline-offset-2"
        >
          1분 만에 연결 →
        </Link>
      </div>
    </div>
  );
}
