// Presentational plan-limit gauges, shared by the member-detail card and the
// overview. A member may own several Claude accounts (1:N), so snapshots are
// grouped by accountEmail, with one bar per rate-limit window under each.
import type { LimitSnapshot } from "@/lib/queries";
import { organizationLabels, windowLabel } from "@/lib/limit-window";

// "3분 전" / "2시간 전" — snapshot freshness. Server-rendered; minute precision
// is enough for a metric that changes on upload cadence.
function agoLabel(iso: string | null): string | null {
  if (!iso) return null;
  const mins = Math.floor((Date.now() - Date.parse(iso)) / 60000);
  if (!Number.isFinite(mins) || mins < 0) return null;
  if (mins < 1) return "방금 갱신";
  if (mins < 60) return `${mins}분 전 갱신`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}시간 전 갱신`;
  return `${Math.floor(hours / 24)}일 전 갱신`;
}

// "리셋까지 2시간 10분" — from the window's resets_at. Past timestamps mean the
// window already rolled over; show nothing rather than a negative count.
function resetLabel(iso: string | null): string | null {
  if (!iso) return null;
  const mins = Math.ceil((Date.parse(iso) - Date.now()) / 60000);
  if (!Number.isFinite(mins) || mins <= 0) return null;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h > 0 ? `리셋까지 ${h}시간 ${m}분` : `리셋까지 ${m}분`;
}

// >=90% red, >=70% amber, else green — the same thresholds the /me card uses.
function barColor(pct: number): string {
  return pct >= 90
    ? "var(--series-6)"
    : pct >= 70
      ? "var(--series-3)"
      : "var(--series-4)";
}

export function LimitBar({ limit }: { limit: LimitSnapshot }) {
  const pct = Math.max(0, Math.min(100, Math.round(limit.utilizationPct)));
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between text-xs">
        <span className="text-[var(--text-secondary)]">
          {windowLabel(limit.window)}
          {resetLabel(limit.resetsAt) && (
            <span className="ml-2 text-[var(--text-muted)]">
              {resetLabel(limit.resetsAt)}
            </span>
          )}
        </span>
        <span className="tabular-nums text-[var(--text-muted)]">{pct}%</span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-black/10 dark:bg-white/10">
        <div
          className="h-full rounded-full"
          style={{ width: `${pct}%`, background: barColor(pct) }}
        />
      </div>
    </div>
  );
}

// Group a single member's snapshots by login (account + organization) and
// render each login's windows. Distinct emails are separate accounts; the
// same email under two organizations is two plans of one account (e.g. a
// personal Max subscription and a Team premium seat) and gets two blocks.
// Codex logins are per device ("device:…" org, shown as "기기 N"); pass the
// member's machineIds to match the /me devices table numbering.
export function AccountLimits({
  limits,
  machineIds,
}: {
  limits: LimitSnapshot[];
  machineIds?: string[];
}) {
  const logins = [
    ...new Set(limits.map((l) => `${l.accountEmail}|${l.organization}`)),
  ].sort();
  const orgLabels = organizationLabels(
    limits.map((l) => l.organization),
    machineIds,
  );
  return (
    <div className="space-y-5">
      {logins.map((login) => {
        const [account, organization] = login.split("|");
        const rows = limits
          .filter(
            (l) => l.accountEmail === account && l.organization === organization,
          )
          .sort((a, b) => a.window.localeCompare(b.window));
        const tier = rows[0]?.subscriptionType;
        return (
          <div key={login}>
            <div className="mb-2 flex items-baseline gap-2 text-xs">
              <span className="font-medium text-[var(--text-primary)]">{account}</span>
              {organization && (
                <span className="text-[var(--text-secondary)]">
                  {orgLabels.get(organization) ?? organization}
                </span>
              )}
              {tier && <span className="text-[var(--text-muted)]">{tier}</span>}
              {agoLabel(rows[0]?.updatedAt ?? null) && (
                <span
                  className="ml-auto text-[var(--text-muted)]"
                  title="지금 갱신하려면 내 컴퓨터에서: ~/.token-forest/run.sh --limits-only"
                >
                  {agoLabel(rows[0]?.updatedAt ?? null)}
                </span>
              )}
            </div>
            <div className="space-y-3">
              {rows.map((l) => (
                <LimitBar key={`${login}-${l.window}`} limit={l} />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
