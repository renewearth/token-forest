"use client";

import {
  useActionState,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { MachineStatus, UnmappedRow } from "@/lib/queries";
import { deviceLabels } from "@/lib/machine-id";
import { Card } from "@/app/_components/ui";
import { formatNumber, toolLabel } from "@/app/_lib/ui";
import {
  completeOnboarding,
  requestConnector,
  saveToolPrefs,
  type MeState,
} from "./actions";
import { ClaimButton, CopilotForm, CopyableCommand } from "./client";

// ---- shared style tokens (mirrors client.tsx) --------------------------------

const primaryBtn =
  "rounded-md bg-[var(--series-1)] px-4 py-2 text-sm font-medium text-white disabled:opacity-50";
const ghostBtn =
  "rounded-md border border-black/15 px-4 py-2 text-sm font-medium disabled:opacity-50 dark:border-white/15";
const skipLink = "text-sm text-[var(--text-muted)] underline";
const inputCls =
  "w-full rounded-md border border-black/15 bg-transparent px-3 py-2 text-sm outline-none focus:border-[var(--series-1)] disabled:opacity-40 dark:border-white/15";
const stepTitle = "mb-3 text-base font-semibold text-[var(--text-primary)]";

// ---- step model ---------------------------------------------------------------

type StepId = "tools" | "auto" | "claude" | "copilot" | "custom" | "done";

const STANDARD_TOOLS = new Set(["cursor", "claude_code", "codex", "copilot"]);

const TOOL_OPTIONS: Array<{ key: string; label: string; recommended?: boolean }> = [
  { key: "cursor", label: "Cursor" },
  { key: "claude_code", label: "Claude Code", recommended: true },
  { key: "codex", label: "Codex CLI" },
  { key: "copilot", label: "GitHub Copilot" },
];

// toolPrefs → dynamic step sequence. Tools the member doesn't use never appear.
function buildSteps(prefs: string[]): StepId[] {
  const steps: StepId[] = ["tools"];
  if (prefs.includes("cursor")) steps.push("auto");
  if (prefs.includes("claude_code") || prefs.includes("codex")) steps.push("claude");
  if (prefs.includes("copilot")) steps.push("copilot");
  if (prefs.some((t) => !STANDARD_TOOLS.has(t))) steps.push("custom");
  steps.push("done");
  return steps;
}

// Checklist row click passes a tool name ("claude_code", "copilot", …); map it
// to the wizard step that handles that tool for standalone re-runs.
function stepForTool(tool: string): StepId {
  if (tool === "claude_code" || tool === "codex") return "claude";
  if (tool === "copilot") return "copilot";
  if (tool === "cursor") return "auto";
  return "custom";
}

// ---- small pieces -------------------------------------------------------------

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="rounded border border-black/20 bg-black/5 px-1 py-0.5 font-mono text-[11px] dark:border-white/20 dark:bg-white/5">
      {children}
    </kbd>
  );
}

function ToolToggle({
  active,
  disabled,
  onClick,
  children,
}: {
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      className={`rounded-md border px-3 py-1.5 text-sm transition-colors disabled:opacity-40 ${
        active
          ? "border-[var(--series-1)] bg-[var(--series-1)] font-medium text-white"
          : "border-black/15 text-[var(--text-secondary)] hover:bg-black/5 dark:border-white/15 dark:hover:bg-white/5"
      }`}
    >
      {children}
    </button>
  );
}

function NextButton({
  onClick,
  pending,
  label = "다음",
}: {
  onClick: () => void;
  pending: boolean;
  label?: string;
}) {
  return (
    <button type="button" onClick={onClick} disabled={pending} className={primaryBtn}>
      {pending ? "처리 중…" : label}
    </button>
  );
}

// "관리자에게 자동 수집 요청" — one form per custom tool, inline result message.
function ConnectorRequestForm({ tool }: { tool: string }) {
  const [state, action, pending] = useActionState<MeState, FormData>(
    requestConnector,
    {},
  );
  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="tool" value={tool} />
      <button type="submit" disabled={pending || state.ok} className={ghostBtn}>
        {pending ? "요청 중…" : `"${toolLabel(tool)}" 관리자에게 자동 수집 요청 보내기`}
      </button>
      {state.message && (
        <span
          className={`text-xs ${state.ok ? "text-[var(--series-4)]" : "text-[var(--series-6)]"}`}
        >
          {state.message}
        </span>
      )}
    </form>
  );
}

// ---- wizard -------------------------------------------------------------------

export function OnboardingWizard(props: {
  memberName: string;
  email: string;
  installCmd: string;
  toolPrefs: string[];
  autoClaimed: Array<{ tool: string; tokens: number }>;
  unmapped: UnmappedRow[];
  machines: MachineStatus[];
  initialStep?: string;
}) {
  const router = useRouter();
  // Standalone mode: render exactly one step, no progress bar; exit → /me.
  const single: StepId | null = props.initialStep ? stepForTool(props.initialStep) : null;

  const [prefs, setPrefs] = useState<string[]>(props.toolPrefs);
  const steps = useMemo(() => buildSteps(prefs), [prefs]);
  const [idx, setIdx] = useState(0);
  const currentStep: StepId = single ?? steps[idx] ?? "done";

  const [pending, startTransition] = useTransition();
  const [actionErr, setActionErr] = useState<string | null>(null);

  // Debounce transitions so a double-click on [다음] can't skip a step.
  const lastNextAt = useRef(0);
  const goNext = useCallback(() => {
    const now = Date.now();
    if (now - lastNextAt.current < 300) return;
    lastNextAt.current = now;
    setActionErr(null);
    if (single) {
      router.push("/me");
      return;
    }
    setIdx((i) => Math.min(i + 1, steps.length - 1));
  }, [single, router, steps.length]);

  // ---- step 1 state: tool selection
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(props.toolPrefs.filter((t) => STANDARD_TOOLS.has(t))),
  );
  const [customText, setCustomText] = useState(() =>
    props.toolPrefs.filter((t) => !STANDARD_TOOLS.has(t)).join(", "),
  );
  const [noneChecked, setNoneChecked] = useState(false);

  function submitTools() {
    const tools = noneChecked
      ? []
      : [
          ...TOOL_OPTIONS.filter((o) => selected.has(o.key)).map((o) => o.key),
          ...customText
            .split(",")
            .map((s) => s.trim().toLowerCase())
            .filter((s) => s && !STANDARD_TOOLS.has(s)),
        ];
    const deduped = Array.from(new Set(tools));
    const fd = new FormData();
    fd.set("tools", deduped.join(","));
    startTransition(async () => {
      const res = await saveToolPrefs({}, fd);
      if (res.ok === false) {
        setActionErr(res.message ?? "저장에 실패했습니다. 다시 시도해 주세요.");
        return;
      }
      setActionErr(null);
      setPrefs(deduped);
      setIdx(1);
    });
  }

  // ---- step 3 state: install auto-detection (10s poll, this step only)
  const baseline = useRef(new Set(props.machines.map((m) => m.machineId)));
  const [detected, setDetected] = useState<string | null>(null);
  // Pseudonymous "기기 N" label for the just-detected device — never show the
  // raw machineId (device-id UUID) in the confirmation.
  const machineLabelMap = useMemo(
    () =>
      deviceLabels([
        ...props.machines.map((m) => m.machineId),
        ...(detected ? [detected] : []),
      ]),
    [props.machines, detected],
  );
  useEffect(() => {
    if (currentStep !== "claude" || detected) return;
    const t = setInterval(async () => {
      try {
        const r = await fetch("/api/me/machines");
        if (!r.ok) return;
        const data = await r.json();
        const fresh = (data.machines as MachineStatus[]).find(
          (m) => !baseline.current.has(m.machineId),
        );
        if (fresh) setDetected(fresh.machineId);
      } catch {
        /* transient network error — next tick retries */
      }
    }, 10_000);
    return () => clearInterval(t);
  }, [currentStep, detected]);

  // detected → linger 2s on the success message, then advance automatically.
  // Fires at most once: revisiting the claude step via "← 이전" keeps the ✅
  // confirmation visible without bouncing the member forward again.
  const autoAdvanced = useRef(false);
  useEffect(() => {
    if (currentStep !== "claude" || !detected || autoAdvanced.current) return;
    const t = setTimeout(() => {
      autoAdvanced.current = true;
      goNext();
    }, 2000);
    return () => clearTimeout(t);
  }, [currentStep, detected, goNext]);

  function finish() {
    startTransition(async () => {
      const res = await completeOnboarding();
      if (res.ok === false) {
        setActionErr(res.message ?? "완료 처리에 실패했습니다.");
        return;
      }
      router.refresh(); // revalidated page swaps the wizard for the checklist
    });
  }

  // Standalone custom re-run (/me?step=opencode): focus on the tool named in
  // the URL so the title and connector-request form always show its name, even
  // before it lands in toolPrefs.
  const customTools =
    single === "custom" && props.initialStep && !STANDARD_TOOLS.has(props.initialStep)
      ? [props.initialStep]
      : prefs.filter((t) => !STANDARD_TOOLS.has(t));
  const skipBtn = (
    <button type="button" onClick={goNext} className={skipLink}>
      건너뛰기
    </button>
  );

  return (
    <div className="space-y-3">
      {!single && (
        <div className="space-y-1 text-xs text-[var(--text-muted)]">
          <div className="flex items-center gap-3">
            <span aria-hidden="true" className="tracking-[0.3em] text-[var(--series-1)]">
              {steps.map((_, i) => (i <= idx ? "●" : "○")).join("")}
            </span>
            <span>
              {idx + 1}/{steps.length} 단계
            </span>
          </div>
          {idx > 0 && (
            <button
              type="button"
              onClick={() => setIdx((i) => Math.max(i - 1, 0))}
              className="text-[var(--series-1)] underline"
            >
              ← 이전
            </button>
          )}
        </div>
      )}

      {currentStep === "tools" && (
        <Card>
          <h2 className={stepTitle}>어떤 AI 도구를 쓰시나요?</h2>
          <p className="mb-3 text-sm text-[var(--text-muted)]">
            {props.memberName}님이 쓰는 도구를 모두 골라 주세요. 선택에 맞춰 연결 단계를
            안내해 드려요.
          </p>
          <div className="flex flex-wrap gap-2">
            {TOOL_OPTIONS.map((o) => (
              <ToolToggle
                key={o.key}
                active={selected.has(o.key)}
                disabled={noneChecked}
                onClick={() =>
                  setSelected((prev) => {
                    const next = new Set(prev);
                    if (next.has(o.key)) next.delete(o.key);
                    else next.add(o.key);
                    return next;
                  })
                }
              >
                {o.label}
                {o.recommended && (
                  <span className="ml-1.5 rounded-full bg-black/10 px-1.5 py-0.5 text-[10px] dark:bg-white/15">
                    ⭐ 권장
                  </span>
                )}
              </ToolToggle>
            ))}
          </div>
          <div className="mt-3">
            <label className="mb-1 block text-xs font-medium text-[var(--text-secondary)]">
              기타 도구
            </label>
            <input
              value={customText}
              onChange={(e) => setCustomText(e.target.value)}
              disabled={noneChecked}
              placeholder="예: opencode — 쉼표로 여러 개"
              className={inputCls}
            />
          </div>
          <label className="mt-3 flex items-center gap-2 text-sm text-[var(--text-secondary)]">
            <input
              type="checkbox"
              checked={noneChecked}
              onChange={(e) => {
                setNoneChecked(e.target.checked);
                if (e.target.checked) {
                  setSelected(new Set());
                  setCustomText("");
                }
              }}
            />
            아직 아무것도 안 써요
          </label>
          <div className="mt-4 flex items-center gap-4">
            <NextButton onClick={submitTools} pending={pending} />
            {actionErr && (
              <span className="text-sm text-[var(--series-6)]">{actionErr}</span>
            )}
          </div>
        </Card>
      )}

      {currentStep === "auto" && (
        <Card>
          <h2 className={stepTitle}>자동으로 연결됐어요</h2>
          {props.autoClaimed.length === 0 && props.unmapped.length === 0 ? (
            <p className="text-sm text-[var(--text-muted)]">
              선택한 도구의 사용 기록이 아직 없어요 — 사용을 시작하면 자동으로 잡힙니다.
            </p>
          ) : (
            <div className="space-y-4">
              {props.autoClaimed.length > 0 && (
                <ul className="space-y-1.5 text-sm text-[var(--text-secondary)]">
                  {props.autoClaimed.map((a) => (
                    <li key={a.tool}>
                      ✅ {toolLabel(a.tool)} — 회사 관리자 API가 자동 수집 중 (최근 7일{" "}
                      {formatNumber(a.tokens)} 토큰)
                    </li>
                  ))}
                </ul>
              )}
              {props.unmapped.length > 0 && (
                <div>
                  <h3 className="mb-2 text-sm font-medium text-[var(--text-primary)]">
                    혹시 이 기록이 내 것인가요?
                  </h3>
                  <p className="mb-2 text-xs text-[var(--text-muted)]">
                    등록 이메일(<code>{props.email}</code>)과 다른 ID로 남은
                    기록이에요. 이메일로 남은 기록은 로그인 계정에 자동 연결되고,
                    이메일이 아닌 ID만 본인 것이면 연결할 수 있어요.
                  </p>
                  <table className="w-full max-w-lg text-sm">
                    <tbody>
                      {props.unmapped.map((r) => (
                        <tr
                          key={`${r.tool}-${r.externalId}`}
                          className="border-t border-black/5 first:border-0 dark:border-white/5"
                        >
                          <td className="py-2">{toolLabel(r.tool)}</td>
                          <td className="py-2 font-mono text-xs">{r.externalId}</td>
                          <td className="py-2 text-right tabular-nums">
                            {r.tokens ? formatNumber(r.tokens) : "—"}
                          </td>
                          <td className="py-2 text-right">
                            <ClaimButton tool={r.tool} externalId={r.externalId} claimable={r.claimable} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
          <div className="mt-4">
            <NextButton onClick={goNext} pending={pending} />
          </div>
        </Card>
      )}

      {currentStep === "claude" && (
        <Card>
          <h2 className={stepTitle}>Claude Code 연결 — 30초면 끝나요</h2>
          <CopyableCommand command={props.installCmd} />
          <ol className="mt-3 list-decimal space-y-1.5 pl-5 text-sm text-[var(--text-secondary)]">
            <li>위 명령을 복사하세요 (오른쪽 복사 버튼)</li>
            <li>
              <Kbd>⌘</Kbd>+<Kbd>스페이스</Kbd> → &ldquo;터미널&rdquo; 입력 →{" "}
              <Kbd>Enter</Kbd>
            </li>
            <li>
              검은 창에 <Kbd>⌘</Kbd>+<Kbd>V</Kbd> 붙여넣고 <Kbd>Enter</Kbd>
            </li>
          </ol>
          <p className="mt-2 text-xs text-[var(--text-muted)]">
            이 설치는 Codex CLI(<code>~/.codex</code>) 사용량도 함께 수집합니다 — 별도 설치가
            필요 없어요.
          </p>
          {detected ? (
            <div className="mt-4 rounded-lg border border-[var(--series-4)]/50 bg-[var(--series-4)]/5 p-3 text-sm font-medium text-[var(--series-4)]">
              ✅ {machineLabelMap.get(detected) ?? detected} 연결 확인됨!
            </div>
          ) : (
            <div className="mt-4 rounded-lg border border-dashed border-black/15 p-3 text-sm text-[var(--text-muted)] dark:border-white/15">
              ⏳ 설치를 기다리는 중… 완료되면 자동으로 넘어갑니다. 이미 등록된 기기에 다시
              설치한 경우엔 감지되지 않아요 — 아래 건너뛰기를 눌러 주세요.
            </div>
          )}
          <details className="mt-4 text-sm">
            <summary className="cursor-pointer text-[var(--text-secondary)]">
              claude.ai(클라우드)에서 쓰는 경우는요?
            </summary>
            <p className="mt-2 text-[var(--text-muted)]">
              claude.ai(클라우드)에서 실행한 세션은 토큰 집계에 포함되지 않습니다. 클라우드
              세션 집계 API는 Anthropic <strong>Enterprise 플랜에서만</strong> 제공되며,
              우리 회사는 Team 플랜이라 사용할 수 없어요.{" "}
              <strong>
                토큰 사용량이 집계되려면 로컬 Claude Code(터미널/데스크톱 앱)에서 실행해
                주세요.
              </strong>{" "}
              클라우드 사용분도 &lsquo;사용 한도&rsquo; 게이지에는 반영됩니다(계정 단위
              소진율).
            </p>
          </details>
          <details className="mt-2 text-sm">
            <summary className="cursor-pointer text-[var(--text-secondary)]">
              개인 Claude 계정도 쓰는데, 그 사용량은 빼고 싶어요
            </summary>
            <div className="mt-2 space-y-2 text-[var(--text-muted)]">
              <p>
                집계는 <strong>기본 프로필(~/.claude)만</strong> 대상입니다. 개인 계정을{" "}
                <strong>별도 프로필로 분리해 쓰면</strong> 그 사용량은 회사 집계에 전혀
                포함되지 않아요. 셸 설정에 한 줄 추가:
              </p>
              <code className="block overflow-x-auto whitespace-nowrap rounded-md bg-black/5 px-2.5 py-1.5 font-mono text-xs dark:bg-white/5">
                alias claude-personal=&apos;CLAUDE_CONFIG_DIR=~/.claude-personal claude&apos;
              </code>
              <p>
                개인 작업은 <code>claude-personal</code>로 실행하면 됩니다(최초 1회 개인
                계정 로그인).{" "}
                <strong>
                  주의: 같은 프로필에서 /login으로 계정만 전환해 쓰면 세션 기록에 계정
                  구분이 남지 않아 어떤 방법으로도 분리할 수 없습니다
                </strong>{" "}
                — 반드시 프로필을 나눠 주세요.
              </p>
            </div>
          </details>
          <div className="mt-4">
            {detected ? <NextButton onClick={goNext} pending={pending} /> : skipBtn}
          </div>
        </Card>
      )}

      {currentStep === "copilot" && (
        <Card>
          <h2 className={stepTitle}>GitHub Copilot 연결 (선택)</h2>
          <div className="space-y-3">
            <a
              href="https://github.com/settings/personal-access-tokens/new"
              target="_blank"
              rel="noreferrer"
              className={`inline-block ${ghostBtn}`}
            >
              GitHub 토큰 만들기 열기 ↗
            </a>
            <p className="text-sm text-[var(--text-secondary)]">
              Token name 아무거나 → Expiration 1년 → Account permissions에서{" "}
              <strong>Plan: Read-only</strong>만 선택 → Generate token
            </p>
            <p className="text-xs text-[var(--text-muted)]">
              저장하면 6월 1일부터의 사용량이 자동으로 소급 수집됩니다.
            </p>
            <CopilotForm />
          </div>
          <div className="mt-4 flex items-center gap-4">
            <NextButton onClick={goNext} pending={pending} />
            {skipBtn}
          </div>
        </Card>
      )}

      {currentStep === "custom" && (
        <Card>
          <h2 className={stepTitle}>
            기타 도구: {customTools.map(toolLabel).join(", ") || "—"}
          </h2>
          <p className="mb-3 text-sm text-[var(--text-secondary)]">
            아직 자동 수집이 지원되지 않는 도구예요. 두 가지 방법이 있어요:
          </p>
          <div className="space-y-3">
            <Link href="/manual" className={`inline-block ${ghostBtn}`}>
              수동으로 사용량 입력하기 →
            </Link>
            {customTools.map((t) => (
              <ConnectorRequestForm key={t} tool={t} />
            ))}
          </div>
          <div className="mt-4">
            <NextButton onClick={goNext} pending={pending} />
          </div>
        </Card>
      )}

      {currentStep === "done" && (
        <Card>
          <h2 className={stepTitle}>
            {prefs.length === 0 ? "Claude Code로 시작해 보세요" : "🎉 온보딩 완료!"}
          </h2>
          <p className="text-sm text-[var(--text-secondary)]">
            {prefs.length === 0
              ? "회사 Team 플랜 좌석이 있어요. 코딩·문서작업·자료조사까지 터미널에서 한 번에. 준비되면 이 페이지에서 언제든 설치할 수 있어요."
              : `선택한 도구 ${prefs.length}개 설정을 마쳤어요. 내일부터 대시보드에서 내 사용량을 확인할 수 있어요. 다른 기기(맥미니 등) 추가는 이 페이지에서 같은 명령으로.`}
          </p>
          <div className="mt-4 flex items-center gap-4">
            <NextButton onClick={finish} pending={pending} label="완료" />
            {actionErr && (
              <span className="text-sm text-[var(--series-6)]">{actionErr}</span>
            )}
          </div>
        </Card>
      )}
    </div>
  );
}
