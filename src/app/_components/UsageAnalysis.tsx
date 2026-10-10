import { observationLabel, type Observation } from "@/lib/observation";
import Link from "next/link";
import type { ReactNode } from "react";
import type { UnitSelection } from "@/lib/units";
import type { NumStyle } from "@/app/_lib/ui";
import { formatUsage } from "@/app/_lib/usage-format";
import { Card, UnpricedNote } from "@/app/_components/ui";
import { UnitPicker } from "@/app/_components/UnitPicker";

// The shared boundary makes the selection's scope visible: total, chart and
// (when present) detail rows all use the same selection passed by the page.
export function UsageAnalysis({
  selection, total, unpricedTokens, numStyle, hasDetails = false, children, observation, range, periodControl,
}: {
  selection: UnitSelection;
  total: number | null;
  observation?: Observation;
  range?: { from: string; to: string };
  periodControl?: ReactNode;
  unpricedTokens: number;
  numStyle: NumStyle;
  hasDetails?: boolean;
  children: ReactNode;
}) {
  const { unit, basis, ref, families } = selection;
  return (
    <Card title="사용량 분석">
      {periodControl && <div className="mb-4">{periodControl}</div>}
      <UnitPicker
        unit={unit} basis={basis} refFamily={ref} families={families} embedded
        scopeNote={hasDetails
          ? "선택한 기준은 아래 합계·그래프·상세표에 함께 적용됩니다."
          : "선택한 기준은 아래 합계·그래프에 함께 적용됩니다."}
      />
      {range && <p className="mb-2 text-xs text-[var(--text-secondary)]">조회 기간: {range.from} ~ {range.to} · KST 달력 선택</p>}
      <div role="group" aria-label="선택 기준 총 사용량" className="mb-6" aria-live="polite">
        <p className="mb-2 text-sm text-[var(--text-secondary)]">{basis === "requests" ? "수집된 전체 요청 수" : "수집된 전체 사용량"}</p>
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <p className="min-w-0 break-words text-3xl font-semibold tracking-tight text-[var(--text-primary)] sm:text-4xl">
            {formatUsage(observation ? observation.value : total, unit, numStyle)}
          </p>
          <span className="text-sm text-[var(--text-muted)]">
            {basis === "requests" ? "건" : unit === "usd" ? "API 정가 환산" : unit === "ref" ? `${ref} 환산 토큰` : "토큰"}
          </span>
        </div>
        <UnpricedNote tokens={unpricedTokens} numStyle={numStyle} />
        <p className="mt-2 text-xs text-[var(--text-secondary)]">{observation ? observationLabel(observation) : "수집 범위 미확인"} · 전체 기기·계정의 수집 범위 미확인</p>
        {observation && !observation.hasRecord && <p className="mt-2 text-xs">수집된 기록이 아직 없습니다. <Link href="/me" className="underline">본인의 연결 상태 확인</Link></p>}
        <p className="mt-1 text-xs text-[var(--text-muted)]">사용량은 업무 성과나 숙련도 점수가 아닙니다.</p>
        {observation && <details className="mt-3 text-xs text-[var(--text-secondary)]">
          <summary className="cursor-pointer">수집 범위·날짜·미확인 항목 보기</summary>
          <div className="mt-2 space-y-2 break-words">
            <p>포함 소스: {observation.sources.join(", ") || "미확인"}</p>
            <p>일자 기준: {observation.dateBases.join(" / ") || "미확인"}{observation.dateBases.length > 1 ? " · 혼합" : ""} · 기존 날짜 버킷 유지</p>
            <p>마지막 사용자료 수신: {observation.lastReceived || "미확인"} · 현재 연결 상태가 과거 수집을 보장하지 않습니다.</p>
            <p>미확인 항목: {observation.unknownFields.map(fieldLabel).join(", ") || (observation.value === null ? "선택 지표를 확인할 수 없습니다" : "명시된 필드 결측 없음 · 전체 수집 범위 미확인")}</p>
            <p>제공되지 않는 항목: {observation.unsupportedFields.map(fieldLabel).join(", ") || "확인된 미지원 없음"}</p>
            {observation.invalid && <p>음수·유한하지 않은 값·소수 요청 등 잘못된 자료를 합계에서 제외했습니다.</p>}
          </div>
        </details>}
      </div>
      {children}
    </Card>
  );
}

function fieldLabel(field: string) { return ({ inputTokens: "일반 입력", outputTokens: "출력", cacheReadTokens: "캐시 읽기", cacheCreationTokens: "캐시 쓰기", requests: "요청 수", sessions: "세션 수" } as Record<string, string>)[field] ?? field; }
