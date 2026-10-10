import { NextRequest, NextResponse } from "next/server";
import { connectDb, Member } from "@/lib/db";
import { computeGrowth } from "@/lib/growth";
import { getGrowthDays, getMyMachines, getLatestLimits, getUnconfirmedGrowthDates } from "@/lib/queries";
import { isoDaysAgo, todayKst, teamEpoch } from "@/lib/date";
import { organizationLabels } from "@/lib/limit-window";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) {
    return NextResponse.json({ error: "missing bearer token" }, { status: 401 });
  }
  await connectDb();
  const member = await Member.findOne({ ingestToken: token }).lean();
  if (!member) {
    return NextResponse.json({ error: "invalid token" }, { status: 401 });
  }

  const id = String(member._id);
  const onboarded = member.onboardedAt
    ? new Date(member.onboardedAt).toISOString().slice(0, 10)
    : null;

  const today = todayKst();
  const [days, machines, limits, unconfirmed] = await Promise.all([
    getGrowthDays(id, onboarded ?? "1970-01-01"),
    getMyMachines(member.email),
    getLatestLimits(id),
    getUnconfirmedGrowthDates(today),
  ]);

  const growth = computeGrowth(days, teamEpoch(), today, undefined, unconfirmed);

  // 최근 7일 활동 툴 수.
  const since7 = isoDaysAgo(7);
  const recent = days.filter((d) => d.date >= since7);
  const tools7d = new Set(recent.flatMap((d) => d.tools)).size;

  const orgLabels = organizationLabels(
    limits.map((l) => l.organization),
    machines.map((m) => m.machineId),
  );

  return NextResponse.json({
    member: member.name,
    onboardedAt: onboarded,
    latestDate: days.length ? days[days.length - 1].date : null,
    // v2 devices + legacy uploader machines (any tool). lastSeenAt/stale are
    // additive — existing menu-bar clients read only machineId/lastActive.
    machines: machines.map((m) => ({
      machineId: m.machineId,
      lastActive: m.lastDate,
      lastSeenAt: m.lastSeenAt,
      stale: m.stale,
    })),
    limits: limits.map((l) => ({
      // Codex rows are per device ("device:…" org): account + "기기 N".
      account: /^device:/.test(l.organization)
        ? `${l.accountEmail} · ${orgLabels.get(l.organization)}`
        : l.organization || l.accountEmail,
      window: l.window,
      utilizationPct: l.utilizationPct,
      resetsAt: l.resetsAt,
    })),
    activeTools7d: tools7d,
    growth,
  });
}
