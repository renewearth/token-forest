"use client";

import { usePathname, useRouter } from "next/navigation";
import { useTransition } from "react";
import {
  BASIS_LABELS, REF_TOOLTIP, USD_DISCLAIMER, basisHint, unitLabel,
  type TokenBasis, type Unit,
} from "@/lib/units";

export function UnitPicker({ unit, basis, refFamily, families, embedded = false, scopeNote }: {
  embedded?: boolean;
  scopeNote?: string;
  unit: Unit;
  basis: TokenBasis;
  refFamily: string | null;
  families: string[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [pending, startTransition] = useTransition();

  function go(next: { unit?: Unit; basis?: TokenBasis; ref?: string }) {
    const p = new URLSearchParams(window.location.search);
    // Make the full selection shareable, including the default basis.
    p.set("basis", next.basis ?? basis);
    p.set("unit", (next.basis ?? basis) === "requests" ? "raw" : next.unit ?? unit);
    const ref = next.ref ?? refFamily;
    if (ref) p.set("ref", ref);
    startTransition(() => router.replace(`${pathname}?${p}`, { scroll: false }));
  }
  const units: Unit[] = refFamily ? ["raw", "usd", "ref"] : ["raw", "usd"];
  return (
    <section aria-label="사용량 표시 설정" aria-busy={pending} className={`mb-4 space-y-2 ${embedded ? "border-b border-[var(--border)] pb-3" : "rounded-xl border border-[var(--border)] bg-[var(--surface-1)] p-4"} ${pending ? "opacity-60" : ""}`}>
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-xs text-[var(--text-secondary)]">
          <span>집계 기준</span>
          <select value={basis} disabled={pending} onChange={(e) => go({ basis: e.target.value as TokenBasis })}
            className="rounded-md border border-[var(--border)] bg-[var(--surface-1)] px-2 py-1.5 text-[var(--text-primary)]">
            {(Object.keys(BASIS_LABELS) as TokenBasis[]).map((b) => <option key={b} value={b}>{BASIS_LABELS[b]}</option>)}
          </select>
        </label>
        {basis === "requests" ? <span className="text-xs text-[var(--text-secondary)]">표시 단위: 건</span> : <div role="group" aria-label="표시 단위" className="inline-flex flex-wrap rounded-lg border border-[var(--border)] p-0.5 text-xs">
          {units.map((u) => (
            <button key={u} type="button" disabled={pending} aria-pressed={unit === u}
              title={u === "ref" ? REF_TOOLTIP : undefined} onClick={() => unit !== u && go({ unit: u })}
              className={`rounded-md px-2.5 py-1.5 transition-colors ${unit === u ? "bg-[var(--series-1)] font-medium text-white" : "text-[var(--text-secondary)] hover:bg-black/5 dark:hover:bg-white/5"}`}>
              {unitLabel(u, refFamily)}
            </button>
          ))}
        </div>}
        {basis !== "requests" && unit === "ref" && refFamily && (
          <label className="flex items-center gap-2 text-xs text-[var(--text-secondary)]">
            <span>기준 모델</span>
            <select value={refFamily} disabled={pending} onChange={(e) => go({ ref: e.target.value })}
              className="max-w-full rounded-md border border-[var(--border)] bg-[var(--surface-1)] px-2 py-1.5 text-[var(--text-primary)]">
              {families.map((f) => <option key={f} value={f}>{f}</option>)}
            </select>
          </label>
        )}
        {pending && <span role="status" className="text-xs text-[var(--text-muted)]">변경 중 · 현재 표시 기준: {BASIS_LABELS[basis]} / {unitLabel(unit, refFamily, basis)}</span>}
      </div>
      {scopeNote && <p className="text-xs font-medium text-[var(--text-secondary)]">{scopeNote}</p>}
      <p className="text-xs text-[var(--text-secondary)]">계산식: {basisHint(basis)}</p>
      <p className="text-[11px] text-[var(--text-muted)]">{basis === "requests" ? "수집된 요청 건수 기준 · 도구별 요청 정의는 다를 수 있으며, 누락 항목은 미확인으로 표시하며 유효한 관측값만 합산합니다." : "수집된 항목 기준 · 누락 항목은 미확인으로 표시하며 유효한 관측값만 합산합니다. 추론 토큰은 출력에 포함됩니다."}</p>
      {unit === "usd" && <p className="text-[11px] text-[var(--text-muted)]">{USD_DISCLAIMER}</p>}
      {unit === "ref" && <p className="text-[11px] text-[var(--text-muted)]">{REF_TOOLTIP}</p>}
    </section>
  );
}
