export const dynamic = "force-dynamic";

import RecentExperiments from "@/app/_components/RecentExperiments";
import { UsageLink } from "@/app/_components/UsageLink";
import { notFound, redirect } from "next/navigation";
import { getLatestLimits, getMember } from "@/lib/queries";
import { getViewer } from "@/lib/auth";
import { parseDays, rangeForDays } from "@/app/_lib/ui";
import { getNumStyle } from "@/app/_lib/numfmt";
import { AccountLimits } from "@/app/_components/limits";
import { MemberUsagePanel } from "@/app/_components/MemberUsagePanel";
import { Card, PageHeader } from "@/app/_components/ui";

export default async function MemberDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ days?: string; unit?: string; ref?: string; basis?: string }>;
}) {
  const { id } = await params;
  const [member, viewer] = await Promise.all([getMember(id), getViewer()]);
  if (!member) notFound();
  const { days: daysParam, unit, ref, basis } = await searchParams;
  // Your own data has one canonical home: /me (내 사용량).
  if (viewer.status === "member" && viewer.member.id === id) {
    const keep = new URLSearchParams();
    for (const [key, value] of Object.entries({ days: daysParam, unit, ref, basis })) {
      if (value) keep.set(key, value);
    }
    redirect(`/me${keep.size ? `?${keep}` : ""}`);
  }

  const days = parseDays(daysParam);
  const range = rangeForDays(days);
  const [numStyle, limits] = await Promise.all([getNumStyle(), getLatestLimits(id)]);

  return (
    <div>
      <UsageLink
        href="/members"
        className="mb-4 inline-block text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)]"
      >
        ← 구성원 목록
      </UsageLink>
      <PageHeader title={member.name} />
      <p className="-mt-4 mb-6 text-xs text-[var(--text-muted)]">
        {member.email} · {range.from} ~ {range.to}
      </p>

      {limits.length > 0 && (
        <Card
          title="Claude 사용 한도"
          hint="계정별 최신 소진율 스냅샷"
          className="mb-4"
        >
          <AccountLimits limits={limits} />
        </Card>
      )}

      <MemberUsagePanel
        memberId={id}
        days={days}
        numStyle={numStyle}
        unitParams={{ unit, ref, basis }}
      />
      <div className="my-6"><RecentExperiments memberId={id} /></div>
    </div>
  );
}
