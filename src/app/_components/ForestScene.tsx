// src/app/_components/ForestScene.tsx
import { ForestActivityButton } from "@/app/_components/ActivityCalendar";
import { activityBadgeDescription, type ActivityCalendarData } from "@/lib/activity-calendar";
import { connectDb, Member, VISIBLE_MEMBER } from "@/lib/db";
import { getGrowthDays, getUnconfirmedGrowthDates } from "@/lib/queries";
import { computeGrowth } from "@/lib/growth";
import { todayKst, teamEpoch } from "@/lib/date";
import { EmptyState } from "@/app/_components/ui";
import {
  timeBand, hash32, treeLayout, pickAnimal,
  ornamentsFor, vitalityView, type TimeBand, type OrnamentZone,
} from "@/lib/forest-scene";

// 팀 숲 장면: 단일 지평선, id 해시 배치(등수 신호 금지), 밤낮 밴드, 습성 동물.
// GP·스테이지·스트릭만 노출 — 토큰 볼륨 절대 금지 (안티게이밍 가드레일).
const STAGE_SIZE: Record<string, number> = {
  dormant: 22, germinated: 26, seedling: 34, sapling: 40, young: 46, mature: 52, ancient: 56,
};

// 나무 기준 장식 오프셋(px). 축마다 장식이 하나라 zone별 자리도 하나씩이다.
// left는 calc(50% + x)로 중앙 기준. top/bottom 중 하나만 지정.
type Off = { x: number; top?: number; bottom?: number; size?: number };
const OFF_BY_ZONE: Record<OrnamentZone, Off[]> = {
  air: [{ x: 0, top: -22, size: 19 }],      // 연속 — 수관 위
  aura: [{ x: -26, top: 2, size: 15 }],     // 사용 보너스 — 수관 왼쪽 위(광채와 함께)
  // 이름표와 불꽃 배지가 나무 아래 약 44px을 차지한다 — 그 위, 밑동 양옆에 둔다.
  ground: [{ x: -34, bottom: 50, size: 19 }], // 최근 활동 — 밑동 왼쪽
  flora: [{ x: 34, bottom: 50, size: 19 }],  // 도구 — 밑동 오른쪽
};

const BAND_BG: Record<TimeBand, string> = {
  dawn: "linear-gradient(#f3e2d9 0%, #ecefdc 55%, #d9e2c4 100%)",
  day: "linear-gradient(#dcebf2 0%, #e8efdc 55%, #d5dfc0 100%)",
  dusk: "linear-gradient(#f2d3ae 0%, #e6e3c4 55%, #d5dfc0 100%)",
  night: "linear-gradient(#101c33 0%, #1c2b45 50%, #22392e 100%)",
};
const BAND_HILL: Record<TimeBand, string> = {
  dawn: "#cbd6a9", day: "#c9d6ae", dusk: "#c2cd9e", night: "#24402f",
};

export default async function ForestScene({ band, activity }: { band?: TimeBand; activity: ActivityCalendarData }) {
  await connectDb();
  const members = await Member.find(VISIBLE_MEMBER, { name: 1 }).lean();
  if (members.length === 0) return <EmptyState message="등록된 구성원이 없습니다." />;
  const today = todayKst();
  const unconfirmed = await getUnconfirmedGrowthDates(today);
  const trees = await Promise.all(
    members.map(async (m) => {
      // 가입일이 아니라 팀 시작일부터 센다 — 모두 같은 날을 기준으로 한다.
      const days = await getGrowthDays(String(m._id), teamEpoch());
      return { id: String(m._id), name: m.name, g: computeGrowth(days, teamEpoch(), today, undefined, unconfirmed) };
    }),
  );

  const kstHour = (new Date().getUTCHours() + 9) % 24;
  const b = band ?? timeBand(kstHour);
  const night = b === "night";
  const animal = pickAnimal(hash32(`${today}-${kstHour}`), b);
  const pos = new Map(treeLayout(trees.map((t) => t.id)).map((p) => [p.id, p]));

  const records = new Map(activity.people.map(p => [p.id, p]));
  const tagCls = night
    ? "mt-0.5 inline-block whitespace-nowrap rounded-lg bg-[#0e1a12cc] px-1.5 text-[10px] text-[#cfe6d5]"
    : "mt-0.5 inline-block whitespace-nowrap rounded-lg bg-[#ffffffcc] px-1.5 text-[10px] text-[#26302a]";

  return (
    <div className="overflow-x-auto rounded-xl" aria-label="팀 숲 가로 이동">
    <section
      aria-label="팀 숲"
      className="fs-scene relative h-64 overflow-hidden rounded-xl border border-[var(--border)]"
      style={{ background: BAND_BG[b], minWidth: Math.max(320, trees.length * 120) }}
    >
      <div className="absolute left-7 top-3 text-2xl">{night ? "🌙" : "☀️"}</div>
      {!night && (
        <>
          <div className="absolute top-4 text-xl opacity-80" style={{ animation: "fs-drift 48s linear infinite" }}>☁️</div>
          <div className="absolute top-11 text-sm opacity-50" style={{ animation: "fs-drift 75s linear -30s infinite" }}>☁️</div>
          <div className="absolute top-16 text-xs opacity-30" style={{ animation: "fs-drift 100s linear -60s infinite" }}>☁️</div>
          <div className="absolute left-[44%] top-12 text-sm" style={{ animation: "fs-leaf-y 11s linear infinite" }}>
            <span className="inline-block" style={{ animation: "fs-leaf-x 11s ease-in-out infinite" }}>🍃</span>
          </div>
          <div className="absolute left-[70%] top-10 text-xs" style={{ animation: "fs-leaf-y 14s linear -6s infinite" }}>
            <span className="inline-block" style={{ animation: "fs-leaf-x 14s ease-in-out -6s infinite" }}>🍃</span>
          </div>
        </>
      )}
      {night && (
        <>
          <div className="absolute left-[30%] top-24 text-[9px]" style={{ animation: "fs-blink 2.4s infinite" }}>✨</div>
          <div className="absolute left-[56%] top-20 text-[9px]" style={{ animation: "fs-blink 3.1s -1s infinite" }}>✨</div>
          <div className="absolute left-[74%] top-28 text-[9px]" style={{ animation: "fs-blink 2.8s -2s infinite" }}>✨</div>
        </>
      )}
      <div
        className="absolute inset-x-0 bottom-0 h-16"
        style={{ background: BAND_HILL[b], borderRadius: "100% 100% 0 0 / 38px" }}
      />
      {trees.map((t) => {
        const p = pos.get(t.id)!;
        const orns = ornamentsFor(t.g.ornaments);
        const vv = vitalityView(t.g.vitality);
        const aura = orns.filter((o) => o.zone === "aura");
        const ember = t.g.ember;
        const record = records.get(t.id);
        const description = record ? activityBadgeDescription(record) : "AI 활동 기록 확인 중";
        return (
          <ForestActivityButton
            key={t.id}
            memberId={t.id}
            title={description}
            aria-label={`${t.name} — ${t.g.stageLabel}, ${t.g.gp} GP · ${description} · 활동 달력 보기`}
            className="absolute bottom-9 -translate-x-1/2 text-center"
            style={{ left: `${p.xPct}%` }}
          >
            <span className={`relative block transition-transform hover:scale-110 ${vv.swayClass}`}>
              {/* 잔불(ember) — 밑동에서 되살릴 수 있는 불씨. 나무 뒤(z-0). */}
              {ember && (
                <span
                  aria-hidden
                  className="fs-orn fs-ember"
                  style={{
                    left: "50%",
                    bottom: 4,
                    width: 52,
                    height: 52,
                    borderRadius: "50%",
                    background:
                      "radial-gradient(circle, rgba(226,102,42,0.62) 0%, rgba(240,163,58,0.32) 45%, transparent 70%)",
                  }}
                />
              )}
              {/* 수관 광채(사용 보너스) — 나무 뒤 */}
              {aura.map((o, i) => (
                <span
                  key={o.key}
                  aria-hidden
                  className={`fs-orn fs-orn-${o.glow ?? "glow"}`}
                  style={{
                    left: "50%",
                    bottom: 8 + i * 6,
                    width: 60,
                    height: 60,
                    borderRadius: "50%",
                    background: "radial-gradient(circle, rgba(240,190,90,0.55) 0%, transparent 62%)",
                    transform: "translateX(-50%)",
                  }}
                />
              ))}
              {/* 활력 — 조는 나무 위 💤 */}
              {vv.sleepEmoji && (
                <span aria-hidden className="fs-orn fs-orn-zzz" style={{ left: "54%", top: -16, fontSize: 13 }}>
                  {vv.sleepEmoji}
                </span>
              )}
              <span className="relative z-10 block" style={{ animation: `fs-gust 16s ease-in-out ${p.gustDelay}s infinite`, transformOrigin: "50% 100%" }}>
                <span
                  className="block"
                  style={{
                    fontSize: STAGE_SIZE[t.g.stage] ?? 26,
                    animation: `fs-sway-${"abc"[p.swayVariant]} ${p.swayDur}s ease-in-out ${p.swayDelay}s infinite`,
                    transformOrigin: "50% 92%",
                  }}
                >
                  {t.g.stageEmoji}
                </span>
              </span>
              {/* 장식 — 축마다 하나 */}
              {orns.map((o) => {
                const off = (OFF_BY_ZONE[o.zone][o.index] ?? { x: 0 }) as Off;
                const v = off.top !== undefined ? { top: off.top } : { bottom: off.bottom ?? 16 };
                return (
                  <span
                    key={o.key}
                    aria-hidden
                    className={`fs-orn fs-orn-${o.motion}`}
                    style={{ left: `calc(50% + ${off.x}px)`, fontSize: off.size ?? 18, ...v }}
                  >
                    {o.emoji}
                  </span>
                );
              })}
              <span className={tagCls}>
                {t.name} Lv{t.g.level}

              </span>
              <span className="mt-1 flex items-center justify-center gap-1" aria-hidden="true">
                <span data-best-activity={t.id} className="rounded-full border border-[#dba56b] bg-[#fff1dc] px-1.5 py-0.5 text-[11px] font-semibold text-[#684019]">🔥{record?.best.length || "·"}</span>
                <span data-current-activity={t.id} className={night ? "text-[9px] text-[#cfe6d5]" : "text-[9px] text-[#526147]"}>{record?.current ?? "·"}</span>
              </span>
            </span>
          </ForestActivityButton>
        );
      })}
      {animal === "🦉" ? (
        <div className="absolute bottom-8 right-10 text-lg" style={{ animation: "fs-owl 12s ease-in-out infinite" }}>🦉</div>
      ) : (
        <div
          className="absolute bottom-6"
          style={{ animation: `${animal === "🦌" ? "fs-amble-x 44s" : "fs-dash-x 32s"} linear infinite` }}
        >
          <span className="inline-block" style={{ animation: "fs-dash-face 32s linear infinite" }}>
            <span
              className="inline-block text-lg"
              style={{
                animation: animal === "🦌" ? undefined : "fs-dash-hop 32s linear infinite",
                ["--fs-hop" as string]: animal === "🐇" ? "-10px" : "-6px",
              }}
            >
              {animal}
            </span>
          </span>
        </div>
      )}
    </section>
    </div>
  );
}
