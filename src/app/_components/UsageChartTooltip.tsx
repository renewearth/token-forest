"use client";

import { useCallback, useEffect, useId, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import type { MouseHandlerDataParam } from "recharts";
import { observationLabel, type Observation } from "@/lib/observation";
import { formatUsage } from "@/app/_lib/usage-format";
import type { NumStyle } from "@/app/_lib/ui";
import type { Unit } from "@/lib/units";

type Detail = { date: string; left: number; top: number; width: number; maxHeight: number; side: "left" | "right"; pinned: boolean };
export type DetailEntry = { key: string; name: string; color: string; dash?: string; observation?: Observation };

// A separate popover keeps the selected date stable while its list receives input.
// Recharts' default tooltip follows the pointer and cannot serve as a scroll surface.
export function useUsageChartDetail() {
  const chartRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [touchMode, setTouchMode] = useState(false);
  const touching = useRef(false);
  const pinned = useRef(false);
  const overCard = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const requestFocus = useRef(false);
  const attachChart = useCallback((node: HTMLDivElement | null) => { chartRef.current = node; }, []);
  const attachCard = useCallback((node: HTMLDivElement | null) => { cardRef.current = node; }, []);
  const pointer = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const next = event.pointerType !== "mouse";
    if (touching.current === next) return;
    touching.current = next;
    setTouchMode(next);
  }, []);

  const cancelClose = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  }, []);
  const dismiss = useCallback(() => {
    cancelClose();
    pinned.current = false;
    overCard.current = false;
    if (cardRef.current?.contains(document.activeElement)) returnFocus.current?.focus({ preventScroll: true });
    setDetail(null);
  }, [cancelClose]);
  const show = useCallback((date: string, coordinate?: { x: number; y: number }, pin = false) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
    const rect = chartRef.current?.querySelector(".recharts-wrapper")?.getBoundingClientRect();
    if (!rect) return;
    cancelClose();
    if (pin && !pinned.current) {
      returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      requestFocus.current = true;
    }
    pinned.current = pin;
    const width = Math.min(344, window.innerWidth - 24);
    const maxHeight = Math.min(432, window.innerHeight - 24);
    const x = rect.left + (coordinate?.x ?? rect.width / 2);
    const y = rect.top + (coordinate?.y ?? 40);
    const side = x + width + 24 <= window.innerWidth ? "right" : "left";
    const left = Math.max(12, Math.min(side === "right" ? x + 12 : x - width - 12, window.innerWidth - width - 12));
    const top = Math.max(12, Math.min(y - 40, window.innerHeight - maxHeight - 12));
    setDetail(previous => previous?.date === date && previous.pinned === pin ? previous : { date, left, top, width, maxHeight, side, pinned: pin });
  }, [cancelClose]);
  const move = useCallback((next: MouseHandlerDataParam) => {
    if (touching.current || pinned.current || overCard.current || !next.isTooltipActive || next.activeLabel == null) return;
    show(String(next.activeLabel), next.activeCoordinate);
  }, [show]);
  const click = useCallback((next: MouseHandlerDataParam) => {
    if (next.activeLabel != null) show(String(next.activeLabel), next.activeCoordinate, true);
  }, [show]);
  const leave = useCallback(() => {
    cancelClose();
    timer.current = setTimeout(() => {
      if (!pinned.current && !overCard.current && !cardRef.current?.contains(document.activeElement)) setDetail(null);
    }, 350);
  }, [cancelClose]);
  const enterCard = useCallback(() => { overCard.current = true; cancelClose(); }, [cancelClose]);
  const leaveCard = useCallback(() => { overCard.current = false; leave(); }, [leave]);
  const pin = useCallback(() => { pinned.current = true; cancelClose(); setDetail(previous => previous ? { ...previous, pinned: true } : previous); }, [cancelClose]);
  const unpin = useCallback(() => { pinned.current = false; setDetail(previous => previous ? { ...previous, pinned: false } : previous); }, []);

  useEffect(() => {
    if (!detail) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !cardRef.current?.contains(event.target) && !chartRef.current?.contains(event.target)) dismiss();
    };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") dismiss(); };
    const scroll = (event: Event) => { if (!(event.target instanceof Node) || !cardRef.current?.contains(event.target)) dismiss(); };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    window.addEventListener("scroll", scroll, true);
    window.addEventListener("resize", dismiss);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
      window.removeEventListener("scroll", scroll, true);
      window.removeEventListener("resize", dismiss);
    };
  }, [detail, dismiss]);
  useEffect(() => {
    if (detail?.pinned && requestFocus.current) {
      requestFocus.current = false;
      cardRef.current?.querySelector<HTMLElement>("[data-usage-detail-list]")?.focus({ preventScroll: true });
    }
  }, [detail?.pinned]);
  useEffect(() => cancelClose, [cancelClose]);

  return { detail, touchMode, pointer, attachChart, attachCard, move, click, leave, enterCard, leaveCard, pin, unpin, dismiss, show };
}

function SeriesMark({ color, dash }: { color: string; dash?: string }) {
  return <svg aria-hidden="true" width="20" height="10" className="shrink-0"><line x1="0" x2="20" y1="5" y2="5" stroke={color} strokeWidth="2.5" strokeDasharray={dash} /></svg>;
}

export function UsageChartTooltip({ control, entries, total, totalLabel, groupLabel, basisLabel, unit, suffix, numStyle }: {
  control: ReturnType<typeof useUsageChartDetail>;
  entries: DetailEntry[];
  total?: Observation;
  totalLabel: string;
  groupLabel: string;
  basisLabel: string;
  unit: Unit;
  suffix: string;
  numStyle: NumStyle;
}) {
  const titleId = useId();
  const { attachCard } = control;
  const detail = control.detail;
  if (!detail) return null;
  const formattedDate = new Intl.DateTimeFormat("ko-KR", { year: "numeric", month: "long", day: "numeric", weekday: "short", timeZone: "UTC" }).format(new Date(`${detail.date}T00:00:00Z`));
  const value = (observation?: Observation) => observation?.value == null ? "—" : formatUsage(observation.value, unit, numStyle);
  const status = (observation?: Observation) => observation ? observationLabel(observation).replace("수집 합계 · ", "") : "수집 미확인";
  return createPortal(
    <div ref={attachCard} role="dialog" aria-modal="false" aria-labelledby={titleId} data-usage-detail={detail.date} data-pinned={detail.pinned}
      onMouseEnter={control.enterCard} onMouseLeave={control.leaveCard} onFocusCapture={control.enterCard}
      onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) control.leaveCard(); }}
      className="fixed z-50 flex flex-col text-[var(--text-primary)]"
      style={{ left: detail.left, top: detail.top, width: detail.width, maxHeight: detail.maxHeight }}>
      <div aria-hidden="true" data-usage-detail-bridge className={`absolute inset-y-0 w-3 ${detail.side === "right" ? "-left-3" : "-right-3"}`} />
      <div className="flex min-h-0 flex-col overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface-1)] shadow-[0_16px_48px_rgba(20,35,25,0.18)]" style={{ maxHeight: detail.maxHeight }}>
      <header className="shrink-0 border-b border-[var(--border)] px-4 pb-3 pt-3">
        <div className="mb-1 flex items-center justify-between gap-2">
          <span className="text-[11px] text-[var(--text-muted)]">일별 사용량 · {basisLabel}</span>
          <div className="flex shrink-0 items-center gap-1">
            <button type="button" aria-pressed={detail.pinned} onClick={detail.pinned ? control.unpin : control.pin} className={`min-h-8 rounded-md px-2 text-[11px] ${detail.pinned ? "bg-[var(--surface-2)] font-semibold text-[var(--accent-strong)]" : "text-[var(--text-muted)] hover:bg-[var(--surface-2)]"}`}>{detail.pinned ? "고정 해제" : "고정"}</button>
            <button type="button" aria-label="사용량 상세 닫기" onClick={control.dismiss} className="flex h-8 w-8 items-center justify-center rounded-md text-lg text-[var(--text-muted)] hover:bg-[var(--surface-2)]">×</button>
          </div>
        </div>
        <h4 id={titleId} className="text-sm font-semibold">{formattedDate}</h4>
        {total && <div className="mt-3 rounded-xl bg-[var(--surface-2)] px-3 py-2.5" data-usage-detail-total>
          <p className="flex items-center gap-2 text-[11px] text-[var(--text-secondary)]"><SeriesMark color="var(--text-primary)" dash="8 4" />{totalLabel}</p>
          <p className="mt-1 flex flex-wrap items-baseline gap-x-1.5"><span className="min-w-0 max-w-full text-2xl font-semibold tabular-nums [overflow-wrap:anywhere]">{value(total)}</span><span className="text-xs text-[var(--text-muted)]">{suffix}</span></p>
          <p className="mt-1 text-[10px] leading-relaxed text-[var(--text-muted)]">{status(total)}</p>
        </div>}
      </header>
      <div className="flex shrink-0 justify-between px-4 pb-1 pt-3 text-[11px] text-[var(--text-muted)]"><span>{groupLabel} {entries.length}{groupLabel === "구성원" ? "명" : "종"}</span><span>표시 중인 선</span></div>
      <div data-usage-detail-list role="region" aria-label={`${groupLabel}별 사용량 목록`} tabIndex={0}
        className="min-h-0 overflow-y-auto overscroll-contain px-4 outline-offset-[-2px] [scrollbar-gutter:stable] [scrollbar-width:thin]">
        <ul className="divide-y divide-[var(--border)]">
          {entries.map(entry => <li key={entry.key} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)] gap-x-3 py-2.5">
            <div className="flex min-w-0 items-start gap-2"><span className="mt-1"><SeriesMark color={entry.color} dash={entry.dash} /></span><span className="min-w-0 break-words text-xs font-medium leading-5">{entry.name}</span></div>
            <p className="min-w-0 text-right text-sm font-semibold tabular-nums leading-5 [overflow-wrap:anywhere]">{value(entry.observation)}<span className="ml-1 text-[10px] font-normal text-[var(--text-muted)]">{suffix}</span></p>
            <p className="col-span-2 ml-7 mt-0.5 text-[10px] leading-relaxed text-[var(--text-muted)]">{status(entry.observation)}</p>
          </li>)}
          {!entries.length && <li className="py-4 text-xs text-[var(--text-muted)]">표시 중인 항목이 없습니다.</li>}
        </ul>
      </div>
      <footer className="shrink-0 border-t border-[var(--border)] px-4 py-2 text-[10px] leading-relaxed text-[var(--text-muted)]">{detail.pinned ? "날짜 고정 중 · 목록을 스크롤해 모두 확인하세요." : "카드 안에서 스크롤 · 그래프를 클릭하면 날짜 고정"}</footer>
      </div>
    </div>, document.body,
  );
}
