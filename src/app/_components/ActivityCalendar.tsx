"use client";

import { createContext, useContext, useState, useRef, type ReactNode, type ButtonHTMLAttributes } from "react";
import { UsageLink } from "@/app/_components/UsageLink";
import { toolLabel } from "@/app/_lib/ui";
import { addDays } from "@/lib/date";
import { type ActivityCalendarData, type ActivityDay, type ActivityPerson } from "@/lib/activity-calendar";

const Selection = createContext<{ id: string; select: (id: string) => void } | null>(null);
export function ActivityCalendarProvider({ initialId, children }: { initialId: string; children: ReactNode }) {
  const [id, select] = useState(initialId);
  return <Selection.Provider value={{ id, select }}>{children}</Selection.Provider>;
}

export function ForestActivityButton({ memberId, children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { memberId: string }) {
  const selection = useContext(Selection);
  return <button {...props} type="button" data-forest-member={memberId} aria-pressed={selection?.id === memberId} onClick={() => {
    selection?.select(memberId);
    const target = document.getElementById("activity-calendar-title");
    target?.focus({ preventScroll: true });
    target?.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth", block: "start" });
  }}>{children}</button>;
}

const STAMPS: Record<number, string> = { 3: "🌸", 7: "🦋", 14: "🐝", 30: "🌈" };
function changeMonth(month: string, delta: number) {
  const date = new Date(`${month}-01T00:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + delta);
  return date.toISOString().slice(0, 7);
}
function status(day: ActivityDay | undefined, date: string, today: string) {
  return date > today ? "아직 오지 않은 날" : day?.active ? "AI 활동 확인" : "활동 확인 중";
}


function ActivityDateDetail({ person, selected, date, today }: { person: ActivityPerson; selected?: ActivityDay; date: string; today: string }) {
  return <>          <p className="text-xs text-[var(--text-muted)]">{person.name}의 기록</p>
          <h3 className="mt-1 text-base font-semibold">{date}</h3>
          <p className="mt-3 text-sm">{status(selected, date, today)}</p>
          {selected?.active && <p className="mt-2 text-xs leading-relaxed text-[var(--text-secondary)]">{selected.tools.map(toolLabel).join(" · ")} 사용 기록을 확인했습니다. 같은 날 여러 도구를 써도 활동일은 한 번 셉니다.</p>}
          {!!selected?.achievements.length && <div className="mt-3 rounded-lg bg-[var(--surface-2)] p-3 text-sm">{selected.achievements.map(n => <p key={n}>{STAMPS[n]} 처음으로 연속 AI 활동 {n}일</p>)}<p className="mt-1 text-xs text-[var(--text-muted)]">기록 도장 · 추가 GP 없음</p></div>}
          {!selected?.active && <p className="mt-2 text-xs leading-relaxed text-[var(--text-muted)]">이 날짜의 활동을 확정할 자료가 아직 없습니다. 사용하지 않았다는 뜻은 아닙니다.</p>}
          {!!selected?.sources.length && <ul className="mt-4 space-y-2 text-xs text-[var(--text-muted)]">{selected.sources.map((s, i) => <li key={i}>{toolLabel(s.tool)} · {s.dateBasis} {s.grain === "hour" ? "시간별" : "일별"} 기록{s.confirmed ? s.dateBasis === "UTC" ? " → KST 날짜로 확인" : " · 날짜 확인" : " · KST 날짜 미확인, 원본 날짜에 표시"}</li>)}</ul>}
          <p className="mt-5 text-[11px] leading-relaxed text-[var(--text-muted)]">자료 범위: {person.recordFrom ?? "미확인"}{person.recordFrom ? ` ~ ${today}` : ""}. 기록이 없는 날과 날짜 기준이 불분명한 자료는 연속 기록을 연결하지 않습니다.</p>
          <UsageLink href={`/members/${person.id}`} className="mt-4 inline-block text-xs text-[var(--accent-strong)] underline underline-offset-2">{person.name}의 사용량 보기</UsageLink></>;
}

export function ActivityCalendar({ data }: { data: ActivityCalendarData }) {
  const selection = useContext(Selection);
  const person = data.people.find(p => p.id === selection?.id) ?? data.people[0];
  const [month, setMonth] = useState(data.today.slice(0, 7));
  const [date, setDate] = useState(data.today);
  const dialog = useRef<HTMLDialogElement>(null);
  const chooseDate = (next: string) => {
    setDate(next);
    if (matchMedia("(max-width: 1023px)").matches) dialog.current?.showModal();
  };
  const days = new Map(person?.days.map(d => [d.date, d]) ?? []);
  const first = `${month}-01`;
  const last = addDays(`${changeMonth(month, 1)}-01`, -1);
  const offset = new Date(`${first}T00:00:00Z`).getUTCDay();
  const dates = Array.from({ length: Number(last.slice(-2)) }, (_, i) => addDays(first, i));
  const selected = days.get(date);
  const activityCount = dates.filter(d => days.get(d)?.active).length;
  const navigate = (delta: number) => {
    const next = changeMonth(month, delta);
    setMonth(next); setDate(next === data.today.slice(0, 7) ? data.today : `${next}-01`);
  };
  return <section id="activity-calendar" aria-labelledby="activity-calendar-title" className="my-6 min-w-0 rounded-xl border border-[var(--border)] bg-[var(--surface-1)] p-4 sm:p-5">
    <header className="mb-4 flex flex-wrap items-center justify-between gap-3">
      <div><h2 id="activity-calendar-title" tabIndex={-1} className="scroll-mt-6 text-sm font-semibold">AI 활동 달력</h2>
        <p className="mt-1 text-xs text-[var(--text-muted)]">KST 날짜가 확인된 사용 기록 · 🔥 최장 기록, 작은 숫자는 현재 기록</p></div>
      {!!data.people.length && <label className="flex items-center gap-2 text-xs">구성원
        <select aria-label="달력 구성원" value={person?.id ?? ""} onChange={e => selection?.select(e.target.value)} className="max-w-44 rounded-lg border border-[var(--border)] bg-[var(--surface-1)] px-2 py-2 text-sm">
          {data.people.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select></label>}
    </header>
    {!data.available ? <p role="alert" className="rounded-lg border border-dashed border-[var(--border)] p-6 text-sm">활동 달력을 불러오지 못했습니다. 새로고침해 다시 확인해 주세요.</p> : !person ? <p className="p-6 text-sm text-[var(--text-muted)]">등록된 구성원이 없습니다.</p> : <>
      <div className="grid min-w-0 gap-5 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <div className="min-w-0">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2"><button type="button" aria-label="이전 달" onClick={() => navigate(-1)} className="rounded-lg border border-[var(--border)] px-3 py-2">‹</button>
              <h3 aria-live="polite" className="text-sm font-medium">{month.replace("-", "년 ")}월</h3>
              <button type="button" aria-label="다음 달" disabled={month >= data.today.slice(0, 7)} onClick={() => navigate(1)} className="rounded-lg border border-[var(--border)] px-3 py-2 disabled:opacity-30">›</button>
            </div>
            <span className="text-xs text-[var(--text-secondary)]">{person.name} · 이번 달 확인 {activityCount}일</span>
          </div>
          <div className="grid grid-cols-7 gap-1 text-center text-[11px] text-[var(--text-muted)]" aria-hidden="true">{["일", "월", "화", "수", "목", "금", "토"].map(d => <span key={d} className="py-1">{d}</span>)}</div>
          <div className="grid grid-cols-7 gap-1" aria-label={`${person.name} ${month} 활동 날짜`}>
            {Array.from({ length: offset }, (_, i) => <div key={`empty-${i}`} />)}
            {dates.map(d => { const day = days.get(d), future = d > data.today; const stamp = day?.achievements[0];
              return <button type="button" key={d} data-activity-date={d} disabled={future} aria-pressed={date === d}
                aria-label={`${d} · ${status(day, d, data.today)}${stamp ? ` · 처음으로 연속 ${stamp}일` : ""}`} onClick={() => chooseDate(d)}
                className={`flex min-h-16 min-w-0 flex-col items-center gap-1 rounded-lg border px-0.5 py-1.5 text-xs transition-colors sm:min-h-20 ${date === d ? "border-[var(--accent-strong)] bg-[var(--surface-2)] ring-1 ring-[var(--accent-strong)]" : day?.active ? "border-[var(--border)] bg-[var(--surface-2)]" : "border-dashed border-[var(--border)]"} disabled:border-transparent disabled:opacity-35`}>
                <span className={d === data.today ? "font-bold underline underline-offset-2" : ""}>{Number(d.slice(-2))}</span>
                <span className="text-base" aria-hidden="true">{future ? "" : day?.active ? stamp ? STAMPS[stamp] : "🌱" : "·"}</span>
                {stamp && <span className="text-[9px] text-[var(--text-muted)]">{stamp}일</span>}
              </button>;
            })}
          </div>
          <p className="mt-3 text-[11px] leading-relaxed text-[var(--text-muted)]">🌱 활동 확인 · 🌸/🦋/🐝/🌈 처음으로 연속 3/7/14/30일 · 점선·점은 확인 중</p>
        </div>
        <aside aria-label="활동 날짜 상세" aria-live="polite" className="hidden min-w-0 rounded-lg border border-[var(--border)] p-4 lg:block">
          <ActivityDateDetail person={person} selected={selected} date={date} today={data.today} />
        </aside>
      </div>
      <p className="mt-3 text-xs text-[var(--text-muted)] lg:hidden">날짜를 누르면 상세 기록을 볼 수 있습니다.</p>
      <dialog ref={dialog} aria-label={`${person.name} ${date} 활동 상세`} className="fixed inset-0 m-auto max-h-[85dvh] w-[calc(100%_-_2rem)] max-w-lg overflow-y-auto rounded-xl border border-[var(--border)] bg-[var(--surface-1)] p-5 text-[var(--text-primary)] backdrop:bg-black/30">
        <form method="dialog" className="mb-3 flex justify-end"><button className="rounded-lg border border-[var(--border)] px-3 py-2 text-xs">닫기</button></form>
        <ActivityDateDetail person={person} selected={selected} date={date} today={data.today} />
      </dialog>
    </>}
  </section>;
}
