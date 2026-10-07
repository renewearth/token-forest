"use client";

import { useState } from "react";
import { formatUsage } from "@/app/_lib/usage-format";
import type { TokenBasis, Unit } from "@/lib/units";
import { useNumStyle } from "@/app/_components/NumStyleProvider";

const DOW = ["월", "화", "수", "목", "금", "토", "일"];

// Sequential single-hue (blue, dataviz slot 1): near-zero recedes to the card
// surface, magnitude deepens the same hue. sqrt keeps a few busy cells from
// flattening the rest. Zero cells get a neutral tint so the grid stays legible
// without reading as low usage.
function cellColor(value: number | null, max: number): string {
  if (value === null) return "transparent";
  if (value <= 0) return "color-mix(in srgb, var(--text-muted) 20%, transparent)";
  const pct = 30 + 70 * Math.sqrt(value / max);
  return `color-mix(in srgb, var(--series-1) ${pct}%, transparent)`;
}

export function Heatmap({ matrix, unit = "raw", basis = "all" }: { matrix: Array<Array<number | null>>; unit?: Unit; basis?: TokenBasis }) {
  const numStyle = useNumStyle();
  const [hover, setHover] = useState<{
    dow: number;
    hour: number;
    value: number | null;
    x: number;
    y: number;
  } | null>(null);

  const observedValues = matrix.flat().filter((v): v is number => v !== null);
  const max = Math.max(0, ...observedValues);
  // Header ticks every 3 hours; other columns keep the slot but stay blank.
  const hourLabel = (h: number) => (h % 3 === 0 ? String(h) : "");

  return (
    <div className="relative">
      <div className="overflow-x-auto">
        <div className="min-w-[520px]">
          {/* hour axis */}
          <div className="mb-1 grid grid-cols-[28px_repeat(24,1fr)] gap-[2px]">
            <span />
            {Array.from({ length: 24 }, (_, h) => (
              <span
                key={h}
                className="text-center text-[10px] tabular-nums text-[var(--text-muted)]"
              >
                {hourLabel(h)}
              </span>
            ))}
          </div>
          {matrix.map((row, dow) => (
            <div
              key={dow}
              className="mb-[2px] grid grid-cols-[28px_repeat(24,1fr)] gap-[2px]"
            >
              <span className="flex items-center text-xs text-[var(--text-secondary)]">
                {DOW[dow]}
              </span>
              {row.map((value, hour) => (
                <div
                  key={hour}
                  tabIndex={0}
                  role="img"
                  aria-label={`${DOW[dow]} ${hour}시: ${formatUsage(value, unit)} ${value === null ? "수집 미확인" : "수집 합계 · 일부 수집"}`}
                  title={`${DOW[dow]} ${hour}시: ${formatUsage(value, unit)} · ${value === null ? "수집 미확인" : "일부 수집"}`}
                  className="aspect-square rounded-[2px] border border-[var(--border)] focus:outline-2"
                  onFocus={(e) => { const rect = e.currentTarget.getBoundingClientRect(); setHover({ dow, hour, value, x: rect.left, y: rect.top }); }}
                  onBlur={() => setHover(null)}
                  style={{ background: cellColor(value, max) }}
                  onMouseEnter={(e) =>
                    setHover({
                      dow,
                      hour,
                      value,
                      x: e.clientX,
                      y: e.clientY,
                    })
                  }
                  onMouseMove={(e) =>
                    setHover((h) => (h ? { ...h, x: e.clientX, y: e.clientY } : h))
                  }
                  onMouseLeave={() => setHover(null)}
                />
              ))}
            </div>
          ))}
        </div>
      </div>

      <p className="mt-2 text-xs text-[var(--text-muted)]">빈 칸: 수집 미확인 · 값이 있는 칸: 수집 합계, 일부 수집 · 소스별 기존 시간 버킷 유지</p>
      {/* sequential scale legend */}
      <div className="mt-3 flex items-center gap-2 text-[10px] text-[var(--text-muted)]">
        <span>적음</span>
        <div className="flex gap-[2px]">
          {[0.08, 0.3, 0.55, 0.8, 1].map((f) => (
            <span
              key={f}
              className="h-2.5 w-4 rounded-[2px]"
              style={{ background: cellColor(f * max, max) }}
            />
          ))}
        </div>
        <span>많음 · 최대 {formatUsage(observedValues.length ? max : null, unit, numStyle)}{basis === "requests" ? "건" : unit === "usd" ? "" : " 토큰"}</span>
      </div>

      {hover && (
        <div
          className="pointer-events-none fixed z-20 rounded-md border border-black/10 bg-[var(--surface-1)] px-2.5 py-1.5 text-xs shadow-lg dark:border-white/10"
          style={{ left: hover.x + 12, top: hover.y + 12 }}
        >
          <span className="text-[var(--text-secondary)]">
            {DOW[hover.dow]} {String(hover.hour).padStart(2, "0")}시
          </span>
          <span className="ml-2 font-medium tabular-nums text-[var(--text-primary)]">
            {formatUsage(hover.value, unit)}{basis === "requests" ? "건" : unit === "usd" ? "" : " 토큰"} · {hover.value === null ? "수집 미확인" : "일부 수집"}
          </span>
        </div>
      )}
    </div>
  );
}
