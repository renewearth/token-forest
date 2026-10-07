export const dynamic = "force-dynamic";

import Link from "next/link";
import { getViewer } from "@/lib/auth";
import { addDays, todayKst } from "@/lib/date";
import { listUnpriced, loadPriceTable, MAX_BACKDATE_DAYS } from "@/lib/price-table";
import { formatNumber } from "@/app/_lib/ui";
import { Card, EmptyState, PageHeader, ToolChip } from "@/app/_components/ui";
import DeletePriceButton from "./DeletePriceButton";
import PriceForm from "./PriceForm";

const UNPRICED_DAYS = 90;

function host(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function usd(n: number): string {
  return `$${n.toLocaleString("en-US", { maximumFractionDigits: 4 })}`;
}

export default async function PricingPage() {
  // Viewer first: dynamic request APIs before the DB (see getViewer).
  const viewer = await getViewer();
  const table = await loadPriceTable();
  const today = todayKst();
  // Rows the viewer registered get a delete button (seed rows never do).
  const viewerEmail = viewer.status === "member" ? viewer.member.email : "";
  const unpriced = await listUnpriced({ from: addDays(today, -UNPRICED_DAYS), to: today }, table);
  // Latest entry per (family, provider): what a new version would inherit.
  const families = new Map<string, { family: string; provider: string; match: string[] }>();
  for (const e of [...table.entries].sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))) {
    const key = `${e.family}|${e.provider}`;
    if (!families.has(key)) families.set(key, { family: e.family, provider: e.provider, match: e.match });
  }

  return (
    <div>
      <PageHeader title="모델 단가표" />

      <Card
        title="단가 미정"
        hint={`최근 ${UNPRICED_DAYS}일 · 사용량 순`}
        className="mb-4"
      >
        {unpriced.length ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[480px] text-sm">
              <thead>
                <tr className="text-left text-xs text-[var(--text-muted)]">
                  <th className="pb-2 font-medium">모델</th>
                  <th className="pb-2 font-medium">도구</th>
                  <th className="pb-2 text-right font-medium">처음 본 날</th>
                  <th className="pb-2 text-right font-medium">미환산 토큰(캐시 포함)</th>
                </tr>
              </thead>
              <tbody>
                {unpriced.map((u) => (
                  <tr key={`${u.tool}|${u.model}`} className="border-t border-black/5 dark:border-white/5">
                    <td className="py-2.5 font-mono text-xs">{u.model || "(모델 없음)"}</td>
                    <td className="py-2.5">
                      <ToolChip tool={u.tool} />
                    </td>
                    <td className="py-2.5 text-right text-xs text-[var(--text-muted)]">{u.firstSeen}</td>
                    <td className="py-2.5 text-right tabular-nums">{formatNumber(u.tokens)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-3 text-xs text-[var(--text-muted)]">
              단가가 없는 모델의 토큰은 환산값(보정 지수)에 0으로 들어갑니다. 공개 단가를 찾으면 아래에서
              출처와 함께 등록하세요.
            </p>
          </div>
        ) : (
          <EmptyState message={`최근 ${UNPRICED_DAYS}일 사용량 중 단가 미정 모델이 없습니다.`} />
        )}
      </Card>

      <Card title="등록된 단가" hint="USD / 1M 토큰 · 위에서부터 먼저 매칭" className="mb-4">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[900px] text-sm">
            <thead>
              <tr className="text-left text-xs text-[var(--text-muted)]">
                <th className="pb-2 font-medium">계열</th>
                <th className="pb-2 font-medium">패턴</th>
                <th className="pb-2 font-medium">한정</th>
                <th className="pb-2 font-medium">적용 시작</th>
                <th className="pb-2 text-right font-medium">입력</th>
                <th className="pb-2 text-right font-medium">출력</th>
                <th className="pb-2 text-right font-medium">캐시 읽기</th>
                <th className="pb-2 text-right font-medium">캐시 쓰기</th>
                <th className="pb-2 font-medium">출처</th>
                <th className="pb-2 font-medium">확인일</th>
                <th className="pb-2 font-medium">메모 · 등록</th>
              </tr>
            </thead>
            <tbody>
              {table.entries.map((e) => (
                <tr
                  key={`${e.provider}|${e.family}|${e.effectiveFrom}`}
                  className="border-t border-black/5 align-top dark:border-white/5"
                >
                  <td className="py-2.5 font-medium">{e.family}</td>
                  <td className="py-2.5 font-mono text-xs">
                    {(e.match.length ? e.match : [e.family]).join(", ")}
                  </td>
                  <td className="py-2.5 text-xs">{e.provider || "전체"}</td>
                  <td className="py-2.5 text-xs tabular-nums">{e.effectiveFrom}</td>
                  <td className="py-2.5 text-right tabular-nums">{usd(e.input)}</td>
                  <td className="py-2.5 text-right tabular-nums">{usd(e.output)}</td>
                  <td className="py-2.5 text-right tabular-nums">{usd(e.cacheRead)}</td>
                  <td className="py-2.5 text-right tabular-nums">{usd(e.cacheWrite)}</td>
                  <td className="py-2.5 text-xs">
                    <a
                      href={e.sourceUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[var(--series-1)] hover:underline"
                    >
                      {host(e.sourceUrl)}
                    </a>
                  </td>
                  <td className="py-2.5 text-xs tabular-nums">{e.checkedAt}</td>
                  <td className="py-2.5 text-xs text-[var(--text-muted)]">
                    {e.note}
                    <div>{e.registeredBy}</div>
                    {viewerEmail && e.registeredBy !== "seed" && e.registeredBy === viewerEmail ? (
                      <DeletePriceButton
                        provider={e.provider}
                        family={e.family}
                        effectiveFrom={e.effectiveFrom}
                      />
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card title="단가 등록" hint="구성원 누구나 · 출처 필수">
        {viewer.status === "member" ? (
          <PriceForm
            families={[...families.values()]}
            defaultDate={today}
            minDate={addDays(today, -MAX_BACKDATE_DAYS)}
          />
        ) : (
          <p className="text-sm text-[var(--text-secondary)]">
            단가 등록은 구성원만 할 수 있습니다 — <Link href="/me" className="text-[var(--series-1)] underline">내 사용량</Link>
            에서 로그인하세요.
          </p>
        )}
      </Card>
    </div>
  );
}
