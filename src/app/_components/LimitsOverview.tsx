// Overview widget: every member's latest Claude plan-limit gauges, grouped by
// member and then by account (a member may own several Claude accounts). Fully
// self-contained — the overview page renders <LimitsOverview /> and this
// component loads its own data. Renders nothing when no snapshots exist yet, so
// it stays out of the way until the uploader has reported at least once.
import { getAllMembers, getLatestLimits } from "@/lib/queries";
import { Card } from "@/app/_components/ui";
import { AccountLimits } from "@/app/_components/limits";

export default async function LimitsOverview({
  className = "",
}: {
  className?: string;
}) {
  const [limits, members] = await Promise.all([
    getLatestLimits(),
    getAllMembers(),
  ]);
  if (limits.length === 0) return null;

  const nameById = new Map(members.map((m) => [m.id, m.name]));
  const byMember = new Map<string, typeof limits>();
  for (const l of limits) {
    const list = byMember.get(l.memberId);
    if (list) list.push(l);
    else byMember.set(l.memberId, [l]);
  }
  const memberIds = [...byMember.keys()].sort((a, b) =>
    (nameById.get(a) ?? a).localeCompare(nameById.get(b) ?? b),
  );

  return (
    <Card title="플랜 사용 한도 (Claude·Codex)" hint="구성원·계정별 최신 소진율" className={className}>
      {/* auto-fit collapses empty tracks: one member fills the full card width
          (bars span full), while more members pack 2-up as the card allows. */}
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,260px),1fr))] gap-x-8 gap-y-6">
        {memberIds.map((memberId) => (
          <div key={memberId}>
            <div className="mb-2 text-sm font-semibold text-[var(--text-primary)]">
              {nameById.get(memberId) ?? "(알 수 없는 구성원)"}
            </div>
            <AccountLimits limits={byMember.get(memberId)!} />
          </div>
        ))}
      </div>
    </Card>
  );
}
