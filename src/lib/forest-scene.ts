// ForestScene 순수 로직 — 렌더와 분리해 픽스처로 검증한다.
// 배치는 멤버 id 해시만 사용: GP·레벨은 입력조차 받지 않아 등수 신호가 구조적으로 불가능.

export type TimeBand = "dawn" | "day" | "dusk" | "night";

export function timeBand(kstHour: number): TimeBand {
  if (kstHour >= 5 && kstHour < 8) return "dawn";
  if (kstHour >= 8 && kstHour < 17) return "day";
  if (kstHour >= 17 && kstHour < 20) return "dusk";
  return "night";
}

// FNV-1a 32bit — 렌더 결정성 (Math.random 금지 대체).
export function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export type TreePos = {
  id: string;
  xPct: number; // 좌우 5~95%
  swayVariant: 0 | 1 | 2; // fs-sway-a/b/c
  swayDur: number; // 3.6~5.9s
  swayDelay: number; // 0~-3.9s (위상 분산)
  gustDelay: number; // 0~-15s
};

export function treeLayout(ids: string[]): TreePos[] {
  const sorted = [...ids].sort((a, b) => hash32(a) - hash32(b));
  const n = Math.max(sorted.length, 1);
  const slotW = 84 / n; // 8%~92% 균등 슬롯
  return sorted.map((id, i) => {
    const h = hash32(id);
    const base = 8 + slotW * i + slotW / 2;
    const jitter = ((h % 1000) / 1000 - 0.5) * slotW * 0.4;
    return {
      id,
      xPct: Math.round((base + jitter) * 10) / 10,
      swayVariant: (h % 3) as 0 | 1 | 2,
      swayDur: 3.6 + ((h >>> 8) % 24) / 10,
      swayDelay: -(((h >>> 16) % 40) / 10),
      gustDelay: -((h >>> 24) % 16),
    };
  });
}

const DAY_ANIMALS = ["🐿️", "🐇"] as const;
const NIGHT_ANIMALS = ["🦌", "🦉"] as const;

export function pickAnimal(seed: number, band: TimeBand): string {
  const pool = band === "night" ? NIGHT_ANIMALS : DAY_ANIMALS;
  return pool[seed % pool.length];
}

// --- 마일스톤 장식 매핑 (구역 모델) ---
// 장식 이모지는 growth.ts의 ORNAMENT_CATALOG와 같은 키를 쓴다. 숲 전용 스프라이트 안 만듦.

export type OrnamentZone = "air" | "ground" | "aura" | "flora";

export type Ornament = {
  key: string;
  zone: OrnamentZone;
  emoji: string;
  motion: string; // CSS 클래스 접미 → fs-orn-<motion>
  glow?: string; // aura 전용: 나무 뒤 광채의 CSS 클래스 접미
  index: number; // 같은 zone 내 순번. 축마다 하나만 달리므로 보통 0.
};

// 정의 순서 = 순회 순서 = 결정성. 축마다 단계 오름차순.
const ORNAMENT_MAP: Record<string, { zone: OrnamentZone; emoji: string; motion: string; glow?: string }> = {
  streak_3: { zone: "air", emoji: "🌸", motion: "pulse" },
  streak_7: { zone: "air", emoji: "🦋", motion: "orbit-tight" },
  streak_14: { zone: "air", emoji: "🐝", motion: "orbit-tight" },
  streak_30: { zone: "air", emoji: "🌈", motion: "pulse" },
  streak_60: { zone: "air", emoji: "⭐", motion: "twinkle" },
  streak_100: { zone: "air", emoji: "☄️", motion: "twinkle" },
  recent_days_10: { zone: "ground", emoji: "💧", motion: "pulse" },
  recent_days_15: { zone: "ground", emoji: "🐦", motion: "hop" },
  recent_days_20: { zone: "ground", emoji: "🐿️", motion: "hop" },
  recent_days_25: { zone: "ground", emoji: "🦌", motion: "rest" },
  recent_days_30: { zone: "ground", emoji: "🦉", motion: "blink" },
  recent_bonus_5: { zone: "aura", emoji: "🌤️", motion: "pulse", glow: "glow" },
  recent_bonus_10: { zone: "aura", emoji: "☀️", motion: "pulse", glow: "glow" },
  recent_bonus_15: { zone: "aura", emoji: "🌞", motion: "twinkle", glow: "glow-strong" },
  recent_bonus_25: { zone: "aura", emoji: "🌟", motion: "twinkle", glow: "glow-strong" },
  recent_tools_2: { zone: "flora", emoji: "🍄", motion: "sway-s" },
  recent_tools_3: { zone: "flora", emoji: "🌾", motion: "sway-m" },
  recent_tools_4: { zone: "flora", emoji: "🌻", motion: "sway-l" },
  recent_tools_5: { zone: "flora", emoji: "🌺", motion: "sway-m" },
  recent_tools_6: { zone: "flora", emoji: "🌴", motion: "sway-s" },
};

// 장식 키 → 장식 리스트. 매핑에 없는 키 무시. zone별 index 부여.
export function ornamentsFor(keys: string[]): Ornament[] {
  const has = new Set(keys);
  const byZone: Record<string, number> = {};
  const out: Ornament[] = [];
  for (const key of Object.keys(ORNAMENT_MAP)) {
    if (!has.has(key)) continue;
    const m = ORNAMENT_MAP[key];
    const index = byZone[m.zone] ?? 0;
    byZone[m.zone] = index + 1;
    out.push({ key, zone: m.zone, emoji: m.emoji, motion: m.motion, ...(m.glow ? { glow: m.glow } : {}), index });
  }
  return out;
}

export type VitalityView = { swayClass: string; sleepEmoji: string | null };

export function vitalityView(vitality: "lively" | "neutral" | "dozing"): VitalityView {
  if (vitality === "dozing") return { swayClass: "fs-vital-dozing", sleepEmoji: "💤" };
  if (vitality === "lively") return { swayClass: "fs-vital-lively", sleepEmoji: null };
  return { swayClass: "", sleepEmoji: null };
}
