export const dynamic = "force-dynamic";

import type { Metadata } from "next";
import { Card, PageHeader } from "@/app/_components/ui";

export const metadata: Metadata = {
  title: "설치 안내 · token-forest",
  description: "개인 Claude Code 계정 사용량 업로더 설치 방법",
};

// Static walkthrough for non-developers: how to install the uploader, what it
// changes on their machine, how to remove it, and how to fix common problems.
// Mirrors the dashboard's card/token styling (see _components/ui).

const STEPS = [
  {
    n: "1",
    title: "대시보드 로그인",
    body: "관리자가 공유한 대시보드 주소를 브라우저에서 열고 회사 Google 계정으로 로그인합니다. 별도 앱 설치나 초대 수락은 필요 없습니다.",
  },
  {
    n: "2",
    title: "대시보드 접속",
    body: "브라우저에서 대시보드를 엽니다. 로그인이 되면 접속 환경은 정상입니다.",
  },
  {
    n: "3",
    title: "/me 에서 내 명령 복사",
    body: "대시보드 우상단의 '내 명령'(/me) 페이지에서 나에게 발급된 설치 명령을 복사합니다. 명령에는 본인 전용 토큰이 들어 있으니 공유하지 마세요.",
  },
  {
    n: "4",
    title: "터미널에 붙여넣기",
    body: "macOS 는 터미널, Linux 는 셸을 열고 복사한 명령을 붙여넣어 실행합니다. 설치가 끝나면 한 번 자동 업로드되고 완료 안내가 표시됩니다. 이미 쓰고 있는 사람이 새 기기(맥미니 등)를 추가할 때도 같습니다 — /me 에 항상 표시되는 내 명령을 새 기기에서 한 번 더 실행하면 되고, 기기별 사용량은 자동 합산됩니다.",
  },
];

const CHANGES: { path: string; desc: string }[] = [
  {
    path: "~/.token-forest/uploader/",
    desc: "업로더 프로그램 본체(의존성 없는 Node 스크립트). 재설치 시 이 폴더만 지우고 다시 씁니다.",
  },
  {
    path: "~/.token-forest/run.sh",
    desc: "최근 3일치 사용량을 올리는 실행 래퍼. 훅·예약·수동 실행이 모두 이 파일을 호출합니다.",
  },
  {
    path: "~/.config/token-forest/config.json",
    desc: "서버 주소와 내 업로드 토큰(권한 0600). 다시 설치하면 덮어씁니다. 유지하려면 명령 끝에 --keep-config 를 붙이세요.",
  },
  {
    path: "~/.claude/settings.json",
    desc: "Claude Code 세션이 끝날 때 자동 업로드하도록 SessionEnd 훅 한 줄을 추가합니다. 기존 훅은 보존하며, 이미 있으면 중복 추가하지 않습니다.",
  },
  {
    path: "매시 정각 예약",
    desc: "macOS 는 ~/Library/LaunchAgents/com.token-forest.uploader.plist (launchd), Linux 는 crontab 에 '# token-forest-uploader' 표시가 붙은 한 줄을 등록합니다.",
  },
];

const REMOVE: { label: string; cmd: string }[] = [
  {
    label: "자동 예약 해제 (macOS)",
    cmd: "launchctl unload -w ~/Library/LaunchAgents/com.token-forest.uploader.plist\nrm ~/Library/LaunchAgents/com.token-forest.uploader.plist",
  },
  {
    label: "자동 예약 해제 (Linux)",
    cmd: "crontab -l | grep -v '# token-forest-uploader' | crontab -",
  },
  {
    label: "세션 종료 훅 제거",
    cmd: "~/.claude/settings.json 을 열어 command 에 '.token-forest/run.sh' 가 들어간 SessionEnd 항목을 지웁니다.",
  },
  {
    label: "프로그램·설정 삭제",
    cmd: "rm -rf ~/.token-forest ~/.config/token-forest",
  },
];

const TROUBLESHOOT: { q: string; a: React.ReactNode }[] = [
  {
    q: "\"Node.js 가 설치되어 있지 않습니다\" 라고 나와요",
    a: (
      <>
        업로더는 Node.js 18 이상이 필요합니다. macOS 는{" "}
        <code className="rounded bg-black/5 px-1 dark:bg-white/10">brew install node</code>,
        Linux 는 패키지 매니저(apt/dnf 등) 또는 <span className="whitespace-nowrap">nodejs.org</span>{" "}
        에서 설치한 뒤 명령을 다시 실행하세요.
      </>
    ),
  },
  {
    q: "훅이 잘 걸렸는지 확인하고 싶어요",
    a: (
      <>
        <code className="rounded bg-black/5 px-1 dark:bg-white/10">~/.claude/settings.json</code>{" "}
        의 <code className="rounded bg-black/5 px-1 dark:bg-white/10">hooks.SessionEnd</code> 에{" "}
        <code className="rounded bg-black/5 px-1 dark:bg-white/10">.token-forest/run.sh</code> 를
        호출하는 항목이 있으면 정상입니다. 직접 확인하려면{" "}
        <code className="rounded bg-black/5 px-1 dark:bg-white/10">~/.token-forest/run.sh</code> 를
        실행해 업로드 결과를 볼 수 있습니다.
      </>
    ),
  },
  {
    q: "업로드가 안 되는 것 같아요",
    a: (
      <>
        <code className="rounded bg-black/5 px-1 dark:bg-white/10">~/.token-forest/run.sh</code> 를
        터미널에서 직접 실행해 출력을 확인하세요.{" "}
        <code className="rounded bg-black/5 px-1 dark:bg-white/10">~/.config/token-forest/config.json</code>{" "}
        의 서버 주소(serverUrl)·토큰(token)이 올바른지 점검하면 됩니다. 여러 번 실행해도 서버가 중복을 합치므로 누적되지
        않습니다.
      </>
    ),
  },
  {
    q: "로그인이 안 돼요",
    a: (
      <>
        회사 Google 계정으로 로그인했는지 확인하세요. 브라우저에 개인 Google 계정만 로그인돼
        있으면{" "}
        <span className="whitespace-nowrap">accounts.google.com</span> 에서 회사 계정을
        추가하거나 전환한 뒤 다시 시도합니다. 계정이 맞는데도 접근이 거부되면 관리자에게
        문의하세요.
      </>
    ),
  },
  {
    q: "여러 기기(노트북·맥미니 등)를 쓰면 어떻게 되나요?",
    a: (
      <>
        각 기기에서 같은 설치 명령(/me 의 내 명령)을 한 번씩 실행하면 됩니다. 업로드는 기기별로
        저장되고 대시보드에서 <strong>자동 합산</strong>됩니다. 어떤 기기가 수집되고 있는지는{" "}
        <span className="whitespace-nowrap">/me 의 &lsquo;수집 중인 기기&rsquo;</span> 표에서
        기기 이름·마지막 수집일로 확인할 수 있습니다. 단, 표에는{" "}
        <strong>실제 사용 기록이 업로드된 기기만</strong> 나타납니다 — 설치만 하고 그 기기에서
        Claude Code 를 아직 쓰지 않았다면(예: 작업을 SSH 로 원격 서버에서 하는 경우) 표에 없는 것이
        정상이며, 그 기기에서 처음 사용한 뒤 자동으로 나타납니다. 참고로 설치 시 Claude Code 의
        세션 기록 보존기간을 자동 연장합니다(기본 30일 후 삭제 → 과거 사용량 소급 수집이 가능하도록).
      </>
    ),
  },
  {
    q: "날짜별 집계는 어느 시간대 기준인가요? 과거 사용량은 얼마나 소급되나요?",
    a: (
      <>
        <p>
          날짜 경계는 <strong>KST(한국 표준시)</strong> 기준입니다 — 대시보드의 &lsquo;오늘&rsquo;은
          한국 자정부터 시작합니다. Claude Code 사용량은 트랜스크립트의 실제 시각으로 KST에 정확히
          담깁니다. 반면 Cursor·Copilot 은 각 서비스가 <strong>일 단위(UTC 리포트일)</strong>로만
          제공해, 자정 부근에는 하루가 어긋나 보일 수 있습니다.
        </p>
        <p className="mt-3">
          서버가 끌어오는 도구(Cursor 등)는 팀 추적 시작일부터 전체 소급됩니다. Claude Code 는 설치 시
          최근 이력을 한 번 깊게 수집하지만, <strong>설치 이전에 이미 삭제된 트랜스크립트</strong>(기본
          보존 30일)는 복구할 수 없어 신규 기기는 최대 약 30일까지만 소급됩니다. 설치 이후로는 세션마다
          자동으로 누적됩니다.
        </p>
      </>
    ),
  },
  {
    q: "설치하면 내 컴퓨터에 무엇이 생기나요?",
    a: (
      <ul className="space-y-2.5">
        {CHANGES.map((c) => (
          <li key={c.path} className="text-sm">
            <code className="rounded bg-black/5 px-1.5 py-0.5 font-mono text-[var(--text-primary)] dark:bg-white/10">
              {c.path}
            </code>
            <span className="mt-1 block text-[var(--text-secondary)]">{c.desc}</span>
          </li>
        ))}
      </ul>
    ),
  },
  {
    q: "어떤 데이터를 수집하고, 기기 정보는 어떻게 다루나요?",
    a: (
      <>
        <p>
          수집 항목은 <strong>토큰 수·요청 수·모델·시각</strong>뿐입니다. 대화 내용·프롬프트·코드는
          수집하지 않습니다. 사용량은 기본 프로필(<code className="rounded bg-black/5 px-1 dark:bg-white/10">~/.claude</code>)만
          대상이며, 개인 계정을 별도 <code className="rounded bg-black/5 px-1 dark:bg-white/10">CLAUDE_CONFIG_DIR</code>{" "}
          프로필로 쓰면 수집에서 제외됩니다.
        </p>
        <p className="mt-3">
          기기 식별자는 <strong>익명</strong>입니다 — 설치 시 만든 무작위 ID만 사용하고, 기기
          이름(hostname)은 수집하지 않습니다. 여러 기기 사용량 합산은 이 익명 ID로 이뤄지고,
          대시보드에는 &lsquo;기기 1·2·3&rsquo;으로만 표시됩니다.
        </p>
      </>
    ),
  },
  {
    q: "Claude 계정을 여러 개 쓰는데 한도를 각각 볼 수 있나요?",
    a: (
      <>
        <p>
          네. 핵심은 <strong>Claude Code가 계정마다 설정 폴더를 따로 둔다</strong>는
          점입니다. 기본 계정은{" "}
          <code className="rounded bg-black/5 px-1 dark:bg-white/10">~/.claude</code>, 두
          번째 계정은 다른 폴더(예{" "}
          <code className="rounded bg-black/5 px-1 dark:bg-white/10">~/.claude-team</code>
          )에{" "}
          <code className="rounded bg-black/5 px-1 dark:bg-white/10">CLAUDE_CONFIG_DIR</code>{" "}
          로 로그인합니다. 업로더는 폴더별로 한도를 떠서 계정별로 나눠 보여줍니다.
        </p>
        <p className="mt-3">
          <strong>한 계정을 번갈아 로그인만 한다면</strong> 설정이 필요 없습니다 —
          업로더가 실행 순간 로그인된 계정을 스냅샷하므로, 각 계정은 그 계정이 켜져
          있던 때만 갱신됩니다.
        </p>
        <p className="mt-3">
          <strong>여러 계정을 동시에 추적하려면</strong> 계정마다 폴더를 만들어 등록합니다:
        </p>
        <ol className="mt-2 list-decimal space-y-2 pl-5">
          <li>
            <strong>폴더 확인</strong> —{" "}
            <code className="rounded bg-black/5 px-1 dark:bg-white/10">
              find ~ -maxdepth 3 -name .credentials.json
            </code>{" "}
            로 계정 폴더를 찾습니다.{" "}
            <code className="rounded bg-black/5 px-1 dark:bg-white/10">~/.claude</code>{" "}
            하나만 나오면 두 번째 계정 폴더가 아직 없는 것입니다.
          </li>
          <li>
            <strong>두 번째 계정 로그인</strong> — 새 폴더에 <em>다른</em> 계정으로
            로그인:{" "}
            <code className="rounded bg-black/5 px-1 dark:bg-white/10">
              CLAUDE_CONFIG_DIR=~/.claude-team claude
            </code>{" "}
            실행 후{" "}
            <code className="rounded bg-black/5 px-1 dark:bg-white/10">/login</code>.{" "}
            <strong>
              ⚠️ 두 폴더가 같은 계정이면 하나로 합쳐져 따로 보이지 않습니다 — 반드시
              이메일이 다른 계정을 넣으세요.
            </strong>
          </li>
          <li>
            <strong>업로더에 등록</strong> —{" "}
            <code className="rounded bg-black/5 px-1 dark:bg-white/10">
              ~/.config/token-forest/config.json
            </code>{" "}
            에{" "}
            <code className="rounded bg-black/5 px-1 dark:bg-white/10">
              &quot;claudeDirs&quot;: [&quot;~/.claude-team&quot;]
            </code>{" "}
            를 추가합니다(기본{" "}
            <code className="rounded bg-black/5 px-1 dark:bg-white/10">~/.claude</code>{" "}
            는 자동 포함되니 추가 폴더만 나열). 재설치로 하려면 설치 명령 앞에{" "}
            <code className="rounded bg-black/5 px-1 dark:bg-white/10">
              TOKEN_FOREST_CLAUDE_DIRS=&quot;~/.claude,~/.claude-team&quot;
            </code>{" "}
            를 붙여도 됩니다.
          </li>
          <li>
            <strong>확인</strong> —{" "}
            <code className="rounded bg-black/5 px-1 dark:bg-white/10">
              ~/.token-forest/run.sh --limits-only
            </code>{" "}
            를 실행합니다. 계정이 2개면 한도 창(5시간·7일)까지 쳐서 스냅샷이 여러 개
            올라가고, 대시보드 한도에 계정별로 나뉘어 표시됩니다.
          </li>
        </ol>
        <p className="mt-3">
          보조 계정의 로그인 토큰(약 8시간 만료)은 업로더가 만료 전{" "}
          <strong>자동으로 갱신</strong>하므로 한 번만 로그인해 두면 재로그인이 필요
          없습니다.
        </p>
      </>
    ),
  },
  {
    q: "개인 Claude 계정 사용량은 회사 집계에서 빼고 싶어요",
    a: (
      <>
        집계 경계는 <strong>프로필 단위</strong>입니다 — 사용량은{" "}
        <code className="rounded bg-black/5 px-1 dark:bg-white/10">~/.claude</code>(기본
        프로필)만 수집합니다. 개인 계정을 별도 프로필로 쓰면 자동으로 제외됩니다: 셸
        설정에{" "}
        <code className="rounded bg-black/5 px-1 dark:bg-white/10">
          alias claude-personal=&apos;CLAUDE_CONFIG_DIR=~/.claude-personal claude&apos;
        </code>{" "}
        를 추가하고 개인 작업은 <code className="rounded bg-black/5 px-1 dark:bg-white/10">claude-personal</code>{" "}
        로 실행하세요(최초 1회 로그인). 개인 플랜의 <strong>한도 게이지</strong>는 원할
        때만{" "}
        <code className="rounded bg-black/5 px-1 dark:bg-white/10">claudeDirs</code> 에
        그 프로필을 추가해 따로 켤 수 있습니다(사용량과 무관).{" "}
        <strong>
          주의: 같은 프로필에서 /login 으로 계정만 전환해 쓰면 세션 기록에 계정 구분이
          남지 않아 분리가 불가능합니다
        </strong>{" "}
        — 이 경우 모든 세션이 합산되고, 한도 스냅샷도 실행 시점에 로그인된 계정이
        찍힙니다.
      </>
    ),
  },
  {
    q: "설치 단계를 처음부터 다시 안내받고 싶어요",
    a: (
      <>
        내 사용량(<code className="rounded bg-black/5 px-1 dark:bg-white/10">/me</code>)에서
        온보딩 마법사가 다시 안내합니다. Claude Code 단계만 다시 열려면{" "}
        <code className="rounded bg-black/5 px-1 dark:bg-white/10">/me?step=claude_code</code>{" "}
        로 접속하세요. 설치가 감지되면 자동으로 완료 처리됩니다.
      </>
    ),
  },
  {
    q: "완전히 제거하려면?",
    a: (
      <ul className="space-y-3">
        {REMOVE.map((r) => (
          <li key={r.label}>
            <div className="text-sm font-medium text-[var(--text-primary)]">{r.label}</div>
            <pre className="mt-1 overflow-x-auto rounded-md border border-black/10 bg-black/[0.03] p-2.5 text-xs text-[var(--text-secondary)] dark:border-white/10 dark:bg-white/[0.04]">
              {r.cmd}
            </pre>
          </li>
        ))}
      </ul>
    ),
  },
];

export default function SetupPage() {
  return (
    <div className="space-y-6">
      <PageHeader title="설치 안내" />

      <p className="max-w-2xl text-sm text-[var(--text-secondary)]">
        개인 Claude Code 계정의 토큰 사용량을 대시보드로 보내는 업로더를 설치합니다. 개발 지식 없이도
        아래 순서대로 명령 한 줄을 붙여넣으면 됩니다.
      </p>

      <Card title="설치 순서">
        <ol className="space-y-3">
          {STEPS.map((s) => (
            <li key={s.n} className="flex gap-3">
              <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[var(--series-1)] text-xs font-semibold text-white">
                {s.n}
              </span>
              <div>
                <div className="text-sm font-medium text-[var(--text-primary)]">{s.title}</div>
                <div className="mt-0.5 text-sm text-[var(--text-secondary)]">{s.body}</div>
              </div>
            </li>
          ))}
        </ol>
      </Card>

      <Card title="자주 묻는 질문" hint="항목을 눌러 펼쳐 보세요">
        <div className="divide-y divide-black/5 dark:divide-white/5">
          {TROUBLESHOOT.map((t) => (
            <details key={t.q} className="group py-1">
              <summary className="flex cursor-pointer list-none items-center gap-2 rounded-md px-2 py-2.5 text-sm font-medium text-[var(--text-primary)] hover:bg-black/[0.03] dark:hover:bg-white/[0.04] [&::-webkit-details-marker]:hidden">
                <span className="text-xs text-[var(--text-muted)] transition-transform group-open:rotate-90">
                  ▶
                </span>
                {t.q}
              </summary>
              <div className="px-2 pt-1 pb-3 pl-7 text-sm text-[var(--text-secondary)]">{t.a}</div>
            </details>
          ))}
        </div>
      </Card>
    </div>
  );
}
