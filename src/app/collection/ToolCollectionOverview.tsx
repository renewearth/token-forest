"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { buildToolCollectionRows, collectionOverviewSchema, formatCollectionTime, type CollectionOverview } from "@/lib/collection-overview";

type State = { kind: "loading" | "error" | "login" | "unavailable" } | { kind: "ready"; data: CollectionOverview };
const box = "min-w-0 rounded-2xl border border-[var(--border)] bg-[var(--surface-1)] p-5";
const muted = "text-sm leading-6 text-[var(--text-secondary)]";
const count = (value: number | null) => value === null ? "미확인" : `${value.toLocaleString("ko-KR")}건`;

export default function ToolCollectionOverview({ signedIn }: { signedIn: boolean }) {
  const [state, setState] = useState<State>({ kind: signedIn ? "loading" : "login" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!signedIn) return;
    const controller = new AbortController();
    async function load() {
      try {
        const response = await fetch("/api/me/collection-status", { cache: "no-store", signal: controller.signal });
        if (controller.signal.aborted) return;
        if (response.status === 401) { setState({ kind: "login" }); return; }
        if (response.status === 404) { setState({ kind: "unavailable" }); return; }
        if (!response.ok) throw Error("collection status unavailable");
        const data = collectionOverviewSchema.parse(await response.json());
        if (!controller.signal.aborted) setState({ kind: "ready", data });
      } catch { if (!controller.signal.aborted) setState({ kind: "error" }); }
    }
    void load();
    return () => controller.abort();
  }, [signedIn, attempt]);
  const reload = () => { setState({ kind: "loading" }); setAttempt((n) => n + 1); };

  return <section aria-labelledby="tool-collection-title" className="space-y-5" data-collection-overview>
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><h2 id="tool-collection-title" className="text-xl font-semibold">어떤 도구의 기록을 보고 있나요?</h2><p className={muted}>서버가 받은 기록의 사용 시각과 수신 시각을 따로 확인합니다. 아직 보내지 못한 원본의 최신 사용은 포함하지 않습니다.</p></div>
      {signedIn && state.kind !== "loading" && <button type="button" className="rounded-lg border border-[var(--border)] px-4 py-2 text-sm" onClick={reload}>새로고침</button>}
    </div>
    {state.kind === "loading" ? <div className={box} role="status" aria-busy="true"><p>수집 상태를 불러오는 중입니다.</p><p className={muted}>조회가 끝나기 전에는 이전 숫자를 표시하지 않습니다.</p></div>
      : state.kind === "login" ? <div className={box}><p>로그인하면 본인의 수집 상태를 볼 수 있습니다.</p><Link className="mt-3 inline-block underline" href="/me">내 계정 연결하기</Link></div>
      : state.kind === "error" || state.kind === "unavailable" ? <div className={box} role="alert"><p>{state.kind === "unavailable" ? "현재 이 수집 상태를 조회할 수 없습니다." : "수집 상태를 불러오지 못했습니다."}</p><p className={muted}>조회 실패는 기록이 없거나 사용량이 0이라는 뜻이 아닙니다.</p><button type="button" onClick={reload} className="mt-3 rounded-lg border border-[var(--border)] px-4 py-2 text-sm">다시 확인</button></div>
      : state.kind === "ready" ? <CollectionRows data={state.data} /> : null}
  </section>;
}

export function CollectionRows({ data }: { data: CollectionOverview }) {
  const rows = buildToolCollectionRows(data);
  return <>
    <div className="grid gap-3 sm:grid-cols-3">
      {[{ label: "수신 이력이 있는 기기", value: `${data.deviceStatus.length}대` }, { label: "원본 기록을 받은 도구", value: `${rows.filter((r) => r.records > 0).length}종` }, { label: "원본과 서버의 전체 대조", value: "미확인" }].map((s) => <div key={s.label} className="min-w-0 rounded-xl bg-[var(--surface-2)] p-4"><p className="text-xs text-[var(--text-secondary)]">{s.label}</p><p className="mt-2 text-2xl font-semibold tabular-nums">{s.value}</p></div>)}
    </div>
    {!data.recordCount && <p className="rounded-xl border border-dashed border-[var(--border)] p-4 text-sm" role="status">새 기록별 수신 이력이 아직 없습니다. 기존 일별 사용량은 <Link href="/me" className="underline">내 사용량</Link>에서 확인할 수 있습니다. 사용량 0을 뜻하지 않습니다.</p>}
    {data.staleChains > 0 && <p role="status" className="rounded-xl bg-amber-50 p-4 text-sm text-amber-900">새 기록의 집계 갱신을 기다리고 있습니다. 갱신 전 수치를 완료된 대조로 표시하지 않습니다.</p>}
    <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_260px]">
      <div className="min-w-0 space-y-3">{rows.map((row) => <article key={row.id} className={box} data-tool={row.id}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3"><span aria-hidden="true" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[var(--surface-2)] text-sm font-semibold">{row.icon}</span><div><h3 className="font-semibold">{row.name}</h3><p className="text-xs text-[var(--text-secondary)]">{row.devices.length ? `수신 경로 ${row.devices.length}대` : "기기 연결 확인 필요"}</p></div></div>
          <span className={`rounded-lg px-3 py-1 text-xs font-medium ${row.attention ? "bg-amber-50 text-amber-900" : "bg-[var(--surface-2)] text-[var(--text-secondary)]"}`}>{row.label}</span>
        </div>
        <dl className="mt-4 grid gap-2 text-sm sm:grid-cols-2"><div><dt className="text-xs text-[var(--text-secondary)]">수신한 기록의 최근 사용</dt><dd className="mt-1 tabular-nums">{formatCollectionTime(row.lastSourceAt)}</dd></div><div><dt className="text-xs text-[var(--text-secondary)]">서버 마지막 수신</dt><dd className="mt-1 tabular-nums">{formatCollectionTime(row.lastReceiptAt)}</dd></div></dl>
        <details className="mt-4 border-t border-[var(--border)] pt-3"><summary className="cursor-pointer text-sm font-medium text-[var(--accent-strong)]">{row.name} 상세 · 기기와 확인할 내용</summary>
          <p className={`${muted} mt-3`}>{row.next}</p>
          <p className="mt-2 text-sm">저장된 원천 기록 {row.records.toLocaleString("ko-KR")}건 · 충돌 기록 {row.conflicts.toLocaleString("ko-KR")}건</p><p className="text-xs text-[var(--text-muted)]">원천 기록 건수는 토큰량이나 요청 수가 아닙니다.</p>
          {row.sources.length > 0 && <ul className="mt-3 space-y-2">{row.sources.map((s) => <li key={s.accountId} className="break-all rounded-lg bg-[var(--surface-2)] p-3 text-sm"><p>계정 범위: {s.accountId === "unverified:default" ? "미확인" : s.accountId}</p><p className="mt-1 text-xs text-[var(--text-secondary)]">{s.namespaceVerified === true ? "계정 범위 확인됨" : "실제 계정 범위 확인 필요"} · 원본 식별·완료 상태 미확인 {s.unverifiedCount.toLocaleString("ko-KR")}건</p></li>)}</ul>}
          {row.devices.length ? <ul className="mt-3 space-y-2">{row.devices.map((d) => {
            const receipts = d.sources.filter((s) => s.tool === row.id);
            const parserIssues = d.parserHealth.filter((p) => p.parser === row.id && (p.error || p.readErrors || p.linesUnrecognized));
            return <li key={d.machineId} className="min-w-0 rounded-lg border border-[var(--border)] p-3 text-sm"><p className="break-all font-medium">{d.label || `기기 ${d.machineId.slice(-8)}`}</p><p className="mt-1 text-xs text-[var(--text-secondary)]">마지막 기기 수신 {formatCollectionTime(d.lastReceiptAt)}</p>
              <p className="mt-2">기기 전체 전송 대기 {count(d.pending)} · 거절·충돌 {count(d.reportedRejected)}</p><p className="text-xs text-[var(--text-muted)]">마지막 실행에서 기기가 보고한 값입니다. 이 도구만의 건수가 아니며 도구 간 합산하지 않습니다.</p>
              {parserIssues.length > 0 && <p className="mt-2 text-amber-700">이 도구의 원본 읽기·해석 오류 확인 필요</p>}
              {receipts.map((s) => <p key={s.accountId} className="mt-2 break-words text-xs text-[var(--text-secondary)]">도구 수신 {formatCollectionTime(s.lastReceiptAt)} · 수신 기록의 사용 {formatCollectionTime(s.lastSourceAt)}</p>)}
            </li>;
          })}</ul> : <p className={`${muted} mt-3`}>이 도구의 기기별 수신 경로가 아직 확인되지 않았습니다.</p>}
        </details>
      </article>)}</div>
      <aside className="rounded-2xl bg-[var(--surface-2)] p-5"><h3 className="font-semibold">지원 → 수신 → 대조</h3><ol className="mt-4 space-y-3 text-sm leading-6 text-[var(--text-secondary)]"><li>1. 사용한 도구와 계정이 수집 범위에 있는지 확인합니다.</li><li>2. 받은 기록의 사용 시각과 서버 수신을 따로 봅니다.</li><li>3. 등록한 원본 목록과 서버 기록을 대조합니다.</li></ol><p className="mt-4 border-t border-[var(--border)] pt-4 text-xs leading-5 text-[var(--text-muted)]">아래 수집 범위에서 Cursor와 웹·앱 보고서를 별도로 확인합니다. 원천을 대조하기 전에는 서로 더하지 않습니다.</p></aside>
    </div>
  </>;
}
