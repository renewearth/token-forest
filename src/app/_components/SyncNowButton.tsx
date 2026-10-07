"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// Fires POST /api/sync (poller connectors only) and re-renders the page so
// the freshness card reflects the new run. Claude Code usage/limits are
// uploaded from member machines and can't be pulled from here.
export function SyncNowButton({ readOnly = false }: { readOnly?: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  async function syncNow() {
    if (readOnly) return;
    setBusy(true);
    setNote(null);
    try {
      const res = await fetch("/api/sync", { method: "POST" });
      if (res.ok) {
        setNote("동기화 완료");
        router.refresh();
      } else if (res.status === 429) {
        const body = (await res.json().catch(() => null)) as {
          retryAfterSec?: number;
        } | null;
        const min = Math.max(1, Math.ceil((body?.retryAfterSec ?? 300) / 60));
        setNote(`잠시 전에 동기화됐습니다 — ${min}분 후 다시 시도하세요`);
      } else if (res.status === 409) {
        setNote("동기화가 이미 진행 중입니다");
      } else if (res.status === 401) {
        setNote("구성원만 실행할 수 있습니다 (/me에서 로그인)");
      } else {
        setNote("동기화 요청에 실패했습니다");
      }
    } catch {
      setNote("네트워크 오류로 요청에 실패했습니다");
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex flex-wrap items-center justify-end gap-2">
      {readOnly && <span className="text-xs text-[var(--text-muted)]">조회 전용 미리보기에서는 동기화할 수 없습니다</span>}
      {note && <span className="text-xs text-[var(--text-muted)]">{note}</span>}
      <button
        type="button"
        onClick={syncNow}
        disabled={busy || readOnly}
        className="rounded-lg border border-black/10 px-2.5 py-1 text-xs text-[var(--text-secondary)] transition-colors hover:bg-black/5 disabled:cursor-not-allowed disabled:opacity-60 dark:border-white/10 dark:hover:bg-white/5"
      >
        {busy ? "동기화 중…" : "지금 동기화"}
      </button>
    </span>
  );
}
