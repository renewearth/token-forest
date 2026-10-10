export const dynamic = "force-dynamic";

import { cookies, headers } from "next/headers";
import { Types } from "mongoose";
import Link from "next/link";
import { connectDb, Member, MemberIdentity, UsageDaily } from "@/lib/db";
import {
  getViewer,
  identityHeaderName,
  SESSION_COOKIE,
  trustIdentityHeaders,
} from "@/lib/auth";
import {
  getLatestLimits,
  getMemberBreakdown,
  getMyMachines,
  getUnmappedExternalIds,
  TOKENS_EXPR,
  type LimitSnapshot,
  type MachineStatus,
  type UnmappedRow,
} from "@/lib/queries";
import {
  formatNumber,
  formatTimestamp,
  parseDays,
  rangeForDays,
  toolLabel,
} from "@/app/_lib/ui";
import { getNumStyle } from "@/app/_lib/numfmt";
import { deviceLabels } from "@/lib/machine-id";
import { Card, EmptyState, PageHeader } from "@/app/_components/ui";
import { AccountLimits } from "@/app/_components/limits";
import { MemberUsagePanel } from "@/app/_components/MemberUsagePanel";
import GrowthCard from "./GrowthCard";
import MyExperiments from "@/app/_components/MyExperiments";
import Scorecard from "./Scorecard";
import {
  ClaimButton,
  CopilotForm,
  CopyableCommand,
  LoginForm,
  LogoutButton,
  RegenTokenButton,
  RegisterCard,
} from "./client";
import { OnboardingWizard } from "./wizard";
import { loadPriceTable } from "@/lib/price-table";
import { resolveUnitSelection, unitLabel, unpricedNote, type TokenBasis, type Unit, type SelectionParams } from "@/lib/units";
import { UnitPicker } from "@/app/_components/UnitPicker";
import { formatUsage } from "@/app/_lib/usage-format";

// ---- data -------------------------------------------------------------------

type RecentUsage = { tokens: number; requests: number; unpricedTokens?: number };

// Tools with dedicated checklist rows / wizard steps; everything else in
// toolPrefs is a custom tool (manual entry or a future connector).
const STANDARD_TOOLS = new Set(["cursor", "claude_code", "codex", "gemini", "grok", "opencode", "copilot"]);

type MemberOnboarding = {
  toolPrefs: string[];
  onboardedAt: Date | null;
  customTools: Array<{ tool: string; connected: boolean }>;
  githubConnected: boolean;
  identityTools: Set<string>;
  claudeCodeConnected: boolean;
  codexConnected: boolean;
  geminiConnected: boolean;
  grokConnected: boolean;
  opencodeConnected: boolean;
  recentByTool: Map<string, RecentUsage>;
  myLimits: LimitSnapshot[];
  unmapped: UnmappedRow[];
  machines: MachineStatus[];
};

async function loadOnboarding(
  memberId: string,
  email: string,
): Promise<MemberOnboarding> {
  await connectDb();
  const oid = new Types.ObjectId(memberId);
  const r14 = rangeForDays(14);
  const r7 = rangeForDays(7);

  // toolPrefs drives the custom-tool presence query below, so load it first.
  const memberDoc = await Member.findById(memberId).lean();
  const toolPrefs = memberDoc?.toolPrefs ?? [];
  const customToolNames = toolPrefs.filter((t) => !STANDARD_TOOLS.has(t));

  const [
    identities,
    claudeCodeRow,
    codexRow,
    geminiRow,
    grokRow,
    opencodeRow,
    recent,
    limits,
    unmapped,
    machines,
    customPresent,
  ] = await Promise.all([
      MemberIdentity.find({ memberId: oid }).lean(),
      UsageDaily.findOne({
        tool: "claude_code",
        externalId: email,
        date: { $gte: r14.from },
      }).lean(),
      UsageDaily.findOne({
        tool: "codex",
        memberId: oid,
        date: { $gte: r14.from },
      }).lean(),
      UsageDaily.findOne({
        tool: "gemini",
        memberId: oid,
        date: { $gte: r14.from },
      }).lean(),
      UsageDaily.findOne({
        tool: "grok",
        memberId: oid,
        date: { $gte: r14.from },
      }).lean(),
      UsageDaily.findOne({
        tool: "opencode",
        memberId: oid,
        date: { $gte: r14.from },
      }).lean(),
      UsageDaily.aggregate([
        {
          $match: {
            memberId: oid,
            tool: { $in: ["cursor"] },
            date: { $gte: r7.from, $lte: r7.to },
          },
        },
        {
          $group: {
            _id: "$tool",
            tokens: { $sum: TOKENS_EXPR },
            requests: { $sum: { $ifNull: ["$requests", 0] } },
          },
        },
      ]),
      getLatestLimits(memberId),
      getUnmappedExternalIds(email),
      getMyMachines(email),
      // A custom tool counts as connected once any usage row exists for this
      // member (manual entries are recorded with memberId). toolPrefs is
      // stored lowercase but /manual preserves the typed case ("OpenCode"),
      // so fetch the member's tools and compare case-insensitively in JS.
      customToolNames.length > 0
        ? (UsageDaily.distinct("tool", { memberId: oid }) as Promise<string[]>)
        : Promise.resolve([] as string[]),
    ]);

  const recentByTool = new Map<string, RecentUsage>(
    recent.map((r: { _id: string; tokens: number; requests: number }) => [
      r._id,
      { tokens: r.tokens, requests: r.requests },
    ]),
  );

  const connectedCustom = new Set(customPresent.map((t) => t.toLowerCase()));

  return {
    toolPrefs,
    onboardedAt: memberDoc?.onboardedAt ?? null,
    customTools: customToolNames.map((tool) => ({
      tool,
      connected: connectedCustom.has(tool.toLowerCase()),
    })),
    githubConnected: Boolean(memberDoc?.githubTokenEnc),
    identityTools: new Set(identities.map((i) => i.tool)),
    claudeCodeConnected: Boolean(claudeCodeRow),
    codexConnected: Boolean(codexRow),
    geminiConnected: Boolean(geminiRow),
    grokConnected: Boolean(grokRow),
    opencodeConnected: Boolean(opencodeRow),
    recentByTool,
    myLimits: limits,
    unmapped,
    machines,
  };
}

// origin for the copy-paste installer command, from the incoming request.
async function requestOrigin(): Promise<string> {
  const h = await headers();
  const host = h.get("host") ?? "localhost:3000";
  const proto =
    h.get("x-forwarded-proto") ??
    (host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https");
  return `${proto}://${host}`;
}

// ---- checklist presentation -------------------------------------------------

function StatusBadge({ done }: { done: boolean }) {
  return done ? (
    <span className="text-[var(--series-4)]">✅</span>
  ) : (
    <span className="text-[var(--text-muted)]">⬜</span>
  );
}

function ChecklistRow({
  done,
  title,
  children,
}: {
  done: boolean;
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="border-t border-black/5 py-4 first:border-0 dark:border-white/5">
      <div className="flex items-center gap-2">
        <StatusBadge done={done} />
        <h3 className="text-sm font-semibold text-[var(--text-primary)]">{title}</h3>
      </div>
      {children && <div className="mt-2 pl-6 text-sm">{children}</div>}
    </div>
  );
}

// One device row of the /me "수집 중인 기기" table, plus a warning row when a
// parser looks broken or was skipped. The label is the owner's own device
// name — only this page shows it (team pages keep "기기 N").
function MachineRows({ machine: m, name, unit }: { machine: MachineStatus; name: string; unit: Unit }) {
  const badges: Array<{ text: string; tone: string }> = [];
  if (m.format === "legacy") badges.push({ text: "구 업로더", tone: "text-[var(--text-muted)]" });
  if (m.stale) badges.push({ text: "24시간 넘게 없음", tone: "text-[var(--series-3)]" });
  if (badges.length === 0) badges.push({ text: "정상", tone: "text-[var(--series-1)]" });
  const hasNotes = m.parserWarnings.length > 0 || m.parserErrors.length > 0;
  return (
    <>
      <tr className="border-t border-black/5 dark:border-white/5">
        <td className="py-1.5">{name}</td>
        <td className="py-1.5 text-right tabular-nums">
          {m.lastSeenAt ? formatTimestamp(m.lastSeenAt) : "—"}
        </td>
        <td className="py-1.5 text-right tabular-nums">{m.lastDate}</td>
        <td className="py-1.5 text-right tabular-nums">
          {formatUsage(m.recentTokens, unit)}
          {(m.unpricedTokens ?? 0) > 0 && <div className="text-[11px] text-[var(--text-muted)]">{unpricedNote(formatNumber(m.unpricedTokens ?? 0))}</div>}
        </td>
        <td className="py-1.5 pl-3">
          <span className="flex flex-wrap gap-1">
            {badges.map((b) => (
              <span
                key={b.text}
                className={`whitespace-nowrap rounded-full border border-current px-1.5 py-px text-[11px] ${b.tone}`}
              >
                {b.text}
              </span>
            ))}
          </span>
        </td>
      </tr>
      {hasNotes && (
        <tr>
          <td colSpan={5} className="pb-1.5">
            {m.parserWarnings.map((w) => (
              <div key={w} className="text-[var(--series-6)]">
                ⚠️ {w}
              </div>
            ))}
            {m.parserErrors.map((e) => (
              <div key={e} className="pl-5 text-[11px] text-[var(--text-muted)]">
                {e}
              </div>
            ))}
          </td>
        </tr>
      )}
    </>
  );
}

function recentLine(u: RecentUsage | undefined, unit: Unit, basis: TokenBasis): string | null {
  if (!u || (u.tokens === 0 && u.requests === 0 && !u.unpricedTokens)) return null;
  const parts: string[] = [];
  if (basis !== "requests" && u.tokens > 0) parts.push(`${formatUsage(u.tokens, unit)}${unit === "usd" ? "" : " 토큰"}`);
  if (u.requests > 0) parts.push(`${formatNumber(u.requests)} 요청`);
  if (u.unpricedTokens) parts.push(unpricedNote(formatNumber(u.unpricedTokens)));
  return `최근 7일: ${parts.join(" · ")}`;
}

// ---- views ------------------------------------------------------------------

// "You made it" confirmation for members arriving through the identity
// proxy in front of the dashboard — seeing the badge closes the loop that
// login worked, without naming the specific mechanism behind it.
function IdentityBadge({ email }: { email: string }) {
  return (
    <p className="flex items-center gap-2 text-xs text-[var(--text-secondary)]">
      <span className="inline-block h-2 w-2 rounded-full bg-[var(--series-4)]" />
      로그인 확인됨 — <code>{email}</code>
    </p>
  );
}

function AnonymousView() {
  return (
    <div className="space-y-4">
      <Card title="접근 방법">
        <p className="text-sm text-[var(--text-secondary)]">
          아직 신원이 확인되지 않았습니다. 팀 대시보드 주소(관리자 공지 참조)를 열고{" "}
          <strong>회사 Google 계정으로 로그인</strong>하면 자동으로 신원이 확인됩니다.
        </p>
        <p className="mt-2 text-sm text-[var(--text-secondary)]">
          이 주소에서 계속하려면 발급받은 인제스트 토큰(<code>tmk_…</code>)으로
          로그인하세요.
        </p>
        <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-[var(--text-muted)]">
          <li>Google 로그인 → 이메일 신원으로 자동 인식</li>
          <li>또는 아래 토큰 로그인 (팀 등록 시 발급된 <code>tmk_</code> 토큰)</li>
        </ul>
      </Card>
      <Card title="토큰으로 로그인">
        <LoginForm />
      </Card>
    </div>
  );
}

function UnknownView({ email }: { email: string }) {
  return (
    <div className="space-y-4">
      <IdentityBadge email={email} />
      <Card title="1분 만에 시작">
        <p className="mb-4 text-sm text-[var(--text-secondary)]">
          <code>{email}</code> 신원이 확인됐지만 아직 등록된 계정이 없습니다. 이름만 입력하면
          추적을 시작할 수 있어요.
        </p>
        <RegisterCard email={email} />
      </Card>
    </div>
  );
}

// Tab bar for the member view: usage data (default) vs connection management.
// Server-rendered links, mirroring RangeTabs' pill styling.
function MeTabs({ active, keep }: { active: "usage" | "connect"; keep: Record<string, string> }) {
  const tabs = [
    { key: "usage", href: `/me?${new URLSearchParams(keep)}`, label: "사용량" },
    { key: "connect", href: `/me?${new URLSearchParams({ ...keep, tab: "connect" })}`, label: "연결 관리" },
  ] as const;
  return (
    <div className="inline-flex rounded-lg border border-black/10 p-0.5 text-xs dark:border-white/10">
      {tabs.map((t) => (
        <Link
          key={t.key}
          href={t.href}
          className={`rounded-md px-3 py-1.5 transition-colors ${
            active === t.key
              ? "bg-[var(--series-1)] font-medium text-white"
              : "text-[var(--text-secondary)] hover:bg-black/5 dark:hover:bg-white/5"
          }`}
        >
          {t.label}
        </Link>
      ))}
    </div>
  );
}

async function MemberView({
  member,
  step,
  tab,
  days,
  unitParams,
}: {
  member: { id: string; name: string; email: string; ingestToken: string | null };
  step?: string;
  tab?: string;
  days: number;
  unitParams: SelectionParams;
}) {
  const [data, origin, hasCookie, numStyle, h] = await Promise.all([
    loadOnboarding(member.id, member.email),
    requestOrigin(),
    cookies().then((c) => Boolean(c.get(SESSION_COOKIE))),
    getNumStyle(),
    headers(),
  ]);
  // Mirror getViewer's gate: the identity header is only meaningful when the
  // fronting proxy is trusted. Cookie-session visitors don't get the badge.
  const viaProxy = trustIdentityHeaders() && Boolean(h.get(identityHeaderName()));

  const checks = {
    cursor: data.identityTools.has("cursor"),
    claude_code: data.claudeCodeConnected,
    codex: data.codexConnected,
    gemini: data.geminiConnected,
    grok: data.grokConnected,
    opencode: data.opencodeConnected,
    copilot: data.githubConnected,
  };
  const connectedCount =
    Object.values(checks).filter(Boolean).length +
    data.customTools.filter((c) => c.connected).length;
  const totalCount = Object.keys(checks).length + data.customTools.length;
  // Install host is the public ingest domain — the dashboard host sits behind
  // the login proxy, and curl can't pass through that.
  const ingestHost = process.env.INGEST_HOST;
  const installOrigin = ingestHost ? `https://${ingestHost}` : origin;
  const installCmd = `curl -fsSL ${installOrigin}/install.sh | bash -s -- ${member.ingestToken ?? "<토큰>"}`;
  // Pseudonymous "기기 N" labels — the raw machineId (device-id UUID) is never
  // shown; deviceLabels also renders the "" placeholder. Numbered over the
  // unlabelled machines only, so a member-named device leaves no gap.
  const machineLabelMap = deviceLabels(
    data.machines.filter((m) => !m.label).map((m) => m.machineId),
  );

  // First visit (no onboardedAt) or explicit re-run (?step=…) → wizard.
  const showWizard = !data.onboardedAt || Boolean(step);
  if (showWizard) {
    const autoClaimed = (["cursor"] as const)
      .filter((tool) => checks[tool])
      .map((tool) => ({
        tool,
        tokens: data.recentByTool.get(tool)?.tokens ?? 0,
      }));
    return (
      <div className="space-y-4">
        <PageHeader title="내 사용량" />
        {viaProxy && <IdentityBadge email={member.email} />}
        <OnboardingWizard
          memberName={member.name}
          email={member.email}
          installCmd={installCmd}
          toolPrefs={data.toolPrefs}
          autoClaimed={autoClaimed}
          unmapped={data.unmapped}
          machines={data.machines}
          initialStep={step}
        />
      </div>
    );
  }

  const activeTab = tab === "connect" ? "connect" : "usage";
  const sel = resolveUnitSelection(await loadPriceTable(), unitParams);
  const keep = { days: String(days), unit: sel.unit, basis: sel.basis, ...(sel.ref ? { ref: sel.ref } : {}) };
  const label = unitLabel(sel.unit, sel.ref, sel.basis);
  // The connection wizard retains its existing raw onboarding figures above.
  // Display-only figures below use the same selected basis as the usage panel.
  if (activeTab === "connect") {
    const [recent, machines, unmapped] = await Promise.all([
      getMemberBreakdown(member.id, rangeForDays(7), sel),
      getMyMachines(member.email, undefined, sel),
      getUnmappedExternalIds(member.email, sel),
    ]);
    data.recentByTool = new Map();
    for (const row of recent) {
      const prev = data.recentByTool.get(row.tool) ?? { tokens: 0, requests: 0, unpricedTokens: 0 };
      data.recentByTool.set(row.tool, {
        tokens: prev.tokens + row.tokens,
        requests: prev.requests + row.requests,
        unpricedTokens: (prev.unpricedTokens ?? 0) + (row.unpricedTokens ?? 0),
      });
    }
    data.machines = machines;
    data.unmapped = unmapped;
  }

  return (
    <div className="space-y-4">
      <PageHeader title="내 사용량">
        <div className="flex items-center gap-3">
          <Link
            href={`/me?${new URLSearchParams({ ...keep, tab: "connect" })}`}
            className="rounded-full border border-black/10 px-3 py-1 text-xs text-[var(--text-secondary)] dark:border-white/10"
          >
            {connectedCount}/{totalCount} 연결됨
          </Link>
          {hasCookie && <LogoutButton />}
        </div>
      </PageHeader>

      <p className="-mt-2 text-sm text-[var(--text-muted)]">
        {member.name} · <code>{member.email}</code>
      </p>


      <div className="flex flex-wrap items-center justify-between gap-2">
        <MeTabs active={activeTab} keep={keep} />
      </div>

      {activeTab === "usage" ? (
        <>
          <MemberUsagePanel
            base="/me"
            memberId={member.id}
            days={days}
            numStyle={numStyle}
            unitParams={unitParams}
          />

          {data.myLimits.length > 0 && (
            <Card title="플랜 사용 한도 (Claude·Codex)" hint="계정·플랜별 최신 소진율 스냅샷">
              <AccountLimits
                limits={data.myLimits}
                machineIds={data.machines.map((m) => m.machineId)}
              />
            </Card>
          )}

          <Scorecard memberId={member.id} />
          <MyExperiments memberId={member.id} />
          <GrowthCard memberId={member.id} />
        </>
      ) : (
        <>
      <UnitPicker unit={sel.unit} refFamily={sel.ref} families={sel.families} basis={sel.basis} />
      <Card title="연결 체크리스트">
        <ChecklistRow done={checks.cursor} title="Cursor">
          {checks.cursor ? (
            <p className="text-[var(--text-muted)]">
              {recentLine(data.recentByTool.get("cursor"), sel.unit, sel.basis) ??
                "연결됨 — 관리자 API로 자동 수집됩니다."}
            </p>
          ) : (
            <p className="text-[var(--text-secondary)]">
              Cursor 사용량은 관리자 API로 자동 수집됩니다. 아직 내 계정에 연결되지 않았다면 아래
              <strong> 미매핑 기록</strong>에서 내 Cursor 이메일을 클레임하세요.
            </p>
          )}
        </ChecklistRow>

        <ChecklistRow done={checks.claude_code} title="Claude Code">
          <div className="space-y-2">
            {checks.claude_code ? (
              <p className="text-[var(--text-muted)]">
                최근 14일 내 사용량이 수집되고 있습니다. 다른 기기(맥미니 등)를 추가하려면 그
                기기에서 아래 명령을 실행하세요 — 기기별 사용량은 자동으로 합산됩니다.
              </p>
            ) : (
              <p className="text-[var(--text-secondary)]">
                내 컴퓨터에서 아래 한 줄을 실행하면 Claude Code 사용량 업로더가 설치됩니다.{" "}
                <Link
                  href={`/me?${new URLSearchParams({ ...keep, step: "claude_code" })}`}
                  className="text-[var(--series-1)] underline"
                >
                  연결 마법사 열기
                </Link>
              </p>
            )}
            <CopyableCommand command={installCmd} />
            <p className="text-xs text-[var(--text-muted)]">
              수동 설치 안내는 <Link href="/setup" className="text-[var(--series-1)] underline">설치 가이드</Link>를 참고하세요.
            </p>
            {data.machines.length > 0 && (
              <div className="mt-2">
                <div className="mb-1 text-xs font-medium text-[var(--text-primary)]">
                  수집 중인 기기
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full max-w-2xl text-xs">
                    <thead>
                      <tr className="text-left text-[var(--text-muted)]">
                        <th className="py-1 font-medium">이름</th>
                        <th className="py-1 text-right font-medium">마지막 업로드</th>
                        <th className="py-1 text-right font-medium">마지막 수집일</th>
                        <th className="py-1 text-right font-medium">최근 14일 {label}</th>
                        <th className="py-1 pl-3 font-medium">상태</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.machines.map((m) => (
                        <MachineRows
                          key={m.machineId}
                          machine={m}
                          unit={sel.unit}
                          name={m.label ?? machineLabelMap.get(m.machineId) ?? m.machineId}
                        />
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="mt-1 text-[11px] text-[var(--text-muted)]">
                  여러 기기에서 본 세션은 기기마다 표시되며 합계는 한 번만 셉니다
                </p>
              </div>
            )}
          </div>
        </ChecklistRow>

        <ChecklistRow done={checks.codex} title="Codex CLI">
          {checks.codex ? (
            <p className="text-[var(--text-muted)]">
              연결됨 — Claude Code 업로더가 <code>~/.codex</code> 세션을 함께 수집합니다.
            </p>
          ) : (
            <p className="text-[var(--text-secondary)]">
              Claude Code를 설치하면 <code>~/.codex</code>의 Codex CLI 사용량도 자동으로 함께
              수집돼요. 별도 설치가 필요 없습니다.{" "}
              <Link
                href={`/me?${new URLSearchParams({ ...keep, step: "claude_code" })}`}
                className="text-[var(--series-1)] underline"
              >
                연결 마법사 열기
              </Link>
            </p>
          )}
        </ChecklistRow>

        <ChecklistRow done={checks.gemini} title="Gemini CLI">
          {checks.gemini ? (
            <p className="text-[var(--text-muted)]">
              연결됨 — Claude Code 업로더가 <code>~/.gemini</code> 세션을 함께 수집합니다.
            </p>
          ) : (
            <p className="text-[var(--text-secondary)]">
              Claude Code를 설치하면 <code>~/.gemini</code>의 Gemini CLI 사용량도 자동으로 함께
              수집돼요. 별도 설치가 필요 없습니다.{" "}
              <Link
                href={`/me?${new URLSearchParams({ ...keep, step: "claude_code" })}`}
                className="text-[var(--series-1)] underline"
              >
                연결 마법사 열기
              </Link>
            </p>
          )}
        </ChecklistRow>

        <ChecklistRow done={checks.grok} title="Grok CLI">
          {checks.grok ? (
            <p className="text-[var(--text-muted)]">
              연결됨 — grok-q/grok-web 래퍼가 <code>~/.local/share/grok-usage.jsonl</code>에 남긴
              사용량을 업로더가 함께 수집합니다.
            </p>
          ) : (
            <p className="text-[var(--text-secondary)]">
              grok-q/grok-web 래퍼로 Grok을 쓰면 <code>~/.local/share/grok-usage.jsonl</code>에
              사용량이 쌓이고, Claude Code 업로더가 자동으로 함께 수집해요.{" "}
              <Link
                href={`/me?${new URLSearchParams({ ...keep, step: "claude_code" })}`}
                className="text-[var(--series-1)] underline"
              >
                연결 마법사 열기
              </Link>
            </p>
          )}
        </ChecklistRow>

        <ChecklistRow done={checks.opencode} title="OpenCode">
          {checks.opencode ? (
            <p className="text-[var(--text-muted)]">
              연결됨 — Claude Code 업로더가 <code>opencode.db</code> 세션을 함께 수집합니다.
              opencode로 쓴 Copilot Pro+ 사용량도 여기에 잡혀요.
            </p>
          ) : (
            <p className="text-[var(--text-secondary)]">
              Claude Code 업로더를 설치하면 opencode의 <code>opencode.db</code> 사용량이 자동으로
              함께 수집돼요. opencode로 쓴 Copilot Pro+ 사용량도 여기서 수집됩니다. 별도 설치가
              필요 없습니다.{" "}
              <Link
                href={`/me?${new URLSearchParams({ ...keep, step: "claude_code" })}`}
                className="text-[var(--series-1)] underline"
              >
                연결 마법사 열기
              </Link>
            </p>
          )}
        </ChecklistRow>

        <ChecklistRow done={checks.copilot} title="GitHub Copilot">
          {checks.copilot ? (
            <p className="text-[var(--text-muted)]">
              GitHub 토큰이 저장되어 있습니다. 새 토큰으로 교체하려면 아래에서 다시 저장하세요.
            </p>
          ) : (
            <div className="space-y-3">
              <p className="text-[var(--text-secondary)]">
                Copilot 개인 과금 보고서 조회를 위해 GitHub 사용자명과 fine-grained PAT(권한{" "}
                <strong>Plan: read</strong>)를 등록하세요. PAT는 암호화되어 저장되며 다시
                표시되지 않습니다.{" "}
                <Link
                  href={`/me?${new URLSearchParams({ ...keep, step: "copilot" })}`}
                  className="text-[var(--series-1)] underline"
                >
                  연결 마법사 열기
                </Link>
              </p>
              <CopilotForm />
            </div>
          )}
        </ChecklistRow>

        {data.customTools.map((c) => (
          <ChecklistRow key={c.tool} done={c.connected} title={toolLabel(c.tool)}>
            {c.connected ? (
              <p className="text-[var(--text-muted)]">수동 입력 기록이 있습니다.</p>
            ) : (
              <p className="text-[var(--text-secondary)]">
                자동 수집이 지원되지 않는 도구입니다.{" "}
                <Link href="/manual" className="text-[var(--series-1)] underline">
                  수동 입력
                </Link>
                으로 기록하거나{" "}
                <Link
                  href={`/me?${new URLSearchParams({ ...keep, step: c.tool })}`}
                  className="text-[var(--series-1)] underline"
                >
                  연결 마법사
                </Link>
                에서 커넥터 추가를 요청하세요.
              </p>
            )}
          </ChecklistRow>
        ))}
      </Card>

      <Card title="미매핑 기록 셀프 클레임" hint="아직 구성원에 연결되지 않은 사용 기록">
        {data.unmapped.length === 0 ? (
          <EmptyState message="미매핑 기록이 없습니다." />
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-[var(--text-muted)]">
                <th className="pb-2 font-medium">도구</th>
                <th className="pb-2 font-medium">외부 ID</th>
                <th className="pb-2 text-right font-medium">{label}</th>
                <th className="pb-2 text-right font-medium">요청</th>
                <th className="pb-2 text-right font-medium">최근</th>
                <th className="pb-2 text-right font-medium"> </th>
              </tr>
            </thead>
            <tbody>
              {data.unmapped.map((r) => (
                <tr
                  key={`${r.tool}-${r.externalId}`}
                  className="border-t border-black/5 dark:border-white/5"
                >
                  <td className="py-2">{toolLabel(r.tool)}</td>
                  <td className="py-2 font-mono text-xs">{r.externalId}</td>
                  <td className="py-2 text-right tabular-nums">
                    {formatUsage(r.tokens, sel.unit)}
                    {(r.unpricedTokens ?? 0) > 0 && <div className="text-[11px] text-[var(--text-muted)]">{unpricedNote(formatNumber(r.unpricedTokens ?? 0))}</div>}
                  </td>
                  <td className="py-2 text-right tabular-nums">
                    {r.requests ? formatNumber(r.requests) : "—"}
                  </td>
                  <td className="py-2 text-right text-xs text-[var(--text-muted)]">
                    {r.lastDate}
                  </td>
                  <td className="py-2 text-right">
                    <ClaimButton tool={r.tool} externalId={r.externalId} claimable={r.claimable} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card title="토큰 재발급" hint="danger">
        <p className="mb-3 text-sm text-[var(--text-secondary)]">
          경고: 재발급하면 기존 업로더·설치 스크립트 설정이 즉시 무효화됩니다. 새 토큰으로 다시
          설정해야 합니다.
        </p>
        <RegenTokenButton />
      </Card>
        </>
      )}
    </div>
  );
}

// ---- page -------------------------------------------------------------------

export default async function MePage({
  searchParams,
}: {
  searchParams: Promise<SelectionParams & { step?: string; tab?: string; days?: string }>;
}) {
  const [viewer, { step, tab, days, unit, ref, basis }] = await Promise.all([
    getViewer(),
    searchParams,
  ]);

  return (
    <div>
      {viewer.status === "member" ? (
        <MemberView
          member={viewer.member}
          step={step}
          tab={tab}
          days={parseDays(days)}
          unitParams={{ unit, ref, basis }}
        />
      ) : (
        <>
          <PageHeader title="내 사용량" />
          {viewer.status === "unknown" ? (
            <UnknownView email={viewer.email} />
          ) : (
            <AnonymousView />
          )}
        </>
      )}
    </div>
  );
}
