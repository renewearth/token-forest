import { cache } from "react";
import { z } from "zod";
import { connectDb, ModelPrice as ModelPriceModel, UsageDaily } from "@/lib/db";
import { addDays, todayKst } from "@/lib/date";
import {
  SEED_PRICES,
  newFamilyPriority,
  priceFor,
  type ModelPrice,
  type PriceTable,
} from "@/lib/pricing";

// DB side of the price table (collection `modelprices`). Pure matching lives
// in src/lib/pricing.ts so client code and tests can use it without Mongo.

function toEntry(d: Record<string, unknown>): ModelPrice {
  return {
    family: String(d.family),
    match: Array.isArray(d.match) ? d.match.map(String) : [],
    provider: String(d.provider ?? ""),
    priority: Number(d.priority),
    effectiveFrom: String(d.effectiveFrom),
    input: Number(d.input),
    output: Number(d.output),
    cacheRead: Number(d.cacheRead),
    cacheWrite: Number(d.cacheWrite),
    sourceUrl: String(d.sourceUrl),
    checkedAt: String(d.checkedAt),
    note: String(d.note ?? ""),
    registeredBy: String(d.registeredBy ?? ""),
  };
}

// The unique (provider, family, effectiveFrom) index is what makes seeding and
// registration race-safe, so make sure it exists before the first write
// instead of relying on mongoose's fire-and-forget autoIndex. Once per process.
let indexesReady: Promise<void> | undefined;
async function ready(): Promise<void> {
  await connectDb();
  indexesReady ??= ModelPriceModel.createIndexes().then(
    () => undefined,
    (err) => {
      indexesReady = undefined; // retry next time; reads still work meanwhile
      console.error("[price-table] modelprices index build failed:", err);
    },
  );
  await indexesReady;
}

// Inserts every SEED_PRICES row the collection is missing — on a fresh DB the
// whole seed, on an already-seeded DB only rows added to the code since (e.g.
// new version entries). Upsert-by-key (provider, family, effectiveFrom) with
// $setOnInsert: an existing doc — earlier seed values, an operator's edit, a
// user registration — is never overwritten. Concurrent runs can't duplicate
// rows; a lost race surfaces as E11000 on the unique index and is harmless.
// Consequence: a seed row deleted from the DB comes back on the next process
// start (retire a price with a newer effectiveFrom version instead).
async function seedMissing(): Promise<void> {
  try {
    await ModelPriceModel.bulkWrite(
      SEED_PRICES.map((e) => ({
        updateOne: {
          filter: { provider: e.provider, family: e.family, effectiveFrom: e.effectiveFrom },
          update: { $setOnInsert: e },
          upsert: true,
        },
      })),
      { ordered: false },
    );
  } catch (err) {
    if (!isDuplicateKey(err)) throw err;
  }
}

function isDuplicateKey(err: unknown): boolean {
  const e = err as { code?: number; writeErrors?: Array<{ code?: number }> } | null;
  if (e?.code === 11000) return true;
  return !!e?.writeErrors?.length && e.writeErrors.every((w) => w.code === 11000);
}

// One seeding pass per process, shared by every concurrent caller, so no
// caller reads the table while this process is still half-way through the
// seed. Callers read the table only after it settles. A failed seed is
// retried on the next call.
let seeded: Promise<void> | undefined;
function ensureSeeded(): Promise<void> {
  seeded ??= seedMissing().catch((err) => {
    seeded = undefined;
    throw err;
  });
  return seeded;
}

// The table, loaded once per server request: React cache() dedupes the calls
// that several queries on one page (e.g. /team) make. Outside a React server
// render (CLI scripts) cache() does not memoize, so every call re-reads.
export const loadPriceTable = cache(async function loadPriceTable(): Promise<PriceTable> {
  // Read-only previews use the stored table without creating indexes or seeds.
  // Database permissions / the preview command guard enforce all other writes.
  if (process.env.TOKEN_FOREST_READ_ONLY === "1") {
    await connectDb();
  } else {
    await ready();
    await ensureSeeded();
  }
  const docs = await ModelPriceModel.find().lean();
  return {
    entries: docs
      .map((d) => toEntry(d as unknown as Record<string, unknown>))
      .sort(
        (a, b) =>
          a.priority - b.priority ||
          b.effectiveFrom.localeCompare(a.effectiveFrom) ||
          a.family.localeCompare(b.family) ||
          a.provider.localeCompare(b.provider),
      ),
  };
});

// ---- registration -----------------------------------------------------------

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const dateField = (label: string) =>
  z
    .string({ error: `${label}을 입력하세요` })
    .trim()
    .regex(DATE_RE, `${label}은 YYYY-MM-DD 형식이어야 합니다`)
    .refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)), `${label}이 올바른 날짜가 아닙니다`);

const usdField = z.preprocess(
  (v) => (typeof v === "string" ? (v.trim() === "" ? undefined : Number(v.trim())) : v),
  z
    .number({ error: "단가(USD / 1M 토큰)를 숫자로 입력하세요" })
    .refine((n) => Number.isFinite(n) && n >= 0, "0 이상의 숫자여야 합니다"),
);

const isRegexPattern = (p: string) => p.length >= 2 && p.startsWith("/") && p.endsWith("/");

function isValidPattern(p: string): boolean {
  if (isRegexPattern(p)) {
    try {
      new RegExp(p.slice(1, -1));
      return true;
    } catch {
      return false;
    }
  }
  return true;
}

export const priceInputSchema = z.object({
  family: z
    .string({ error: "계열 이름을 입력하세요" })
    .trim()
    .min(1, "계열 이름을 입력하세요")
    .max(64, "계열 이름은 64자 이하")
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "계열 이름은 영문·숫자·. _ - 만"),
  // Comma-separated patterns (form) or an array; empty → family name.
  match: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .transform((v) =>
      (Array.isArray(v) ? v : (v ?? "").split(","))
        .map((s) => s.trim())
        // Models are matched lowercased; a regex keeps its case (\D ≠ \d).
        .map((s) => (isRegexPattern(s) ? s : s.toLowerCase()))
        .filter((s) => s.length > 0),
    )
    .refine((arr) => arr.every(isValidPattern), "정규식 패턴(/…/)이 올바르지 않습니다"),
  provider: z
    .string()
    .optional()
    .transform((v) => (v ?? "").trim().toLowerCase()),
  effectiveFrom: dateField("적용 시작일"),
  input: usdField,
  output: usdField,
  cacheRead: usdField,
  cacheWrite: usdField,
  sourceUrl: z
    .string({ error: "출처 URL은 필수입니다" })
    .trim()
    .min(1, "출처 URL은 필수입니다")
    .refine((v) => {
      try {
        const u = new URL(v);
        return u.protocol === "https:" && u.hostname.length > 0;
      } catch {
        return false;
      }
    }, "출처 URL은 https:// 로 시작하는 주소여야 합니다"),
  checkedAt: z
    .string()
    .optional()
    .transform((v) => (v ?? "").trim() || todayKst())
    .pipe(dateField("확인일")),
  note: z
    .string()
    .optional()
    .transform((v) => (v ?? "").trim())
    .pipe(z.string().max(500, "메모는 500자 이하")),
});

export type RegisterResult = {
  ok: boolean;
  message?: string;
  errors?: Record<string, string>;
};

const sameSet = (a: string[], b: string[]) =>
  a.length === b.length && [...a].sort().join("\u0000") === [...b].sort().join("\u0000");

// Why each rule exists: one registration must not be able to re-price models
// outside the family it names.
// - Existing family → a new VERSION: match, provider and priority are
//   inherited from its latest entry for that scope (blank match = inherit;
//   a different match is rejected — edit patterns only via a new family).
// - New family → every pattern is a literal substring of ≥3 chars or
//   "=exact"; "/regex/" is seed-only; a pattern that matches the empty model
//   ("=") needs a provider scope. Priority = newFamilyPriority(patterns).
type Resolved = { match: string[]; provider: string; priority: number };
async function resolveFamily(
  d: { family: string; match: string[]; provider: string },
): Promise<Resolved | { errors: Record<string, string> }> {
  const siblings = await ModelPriceModel.find({ family: d.family }).sort({ effectiveFrom: -1 }).lean();
  if (siblings.length) {
    const scopes = [...new Set(siblings.map((s) => s.provider))];
    const scope = d.provider
      ? scopes.includes(d.provider)
        ? d.provider
        : undefined
      : scopes.includes("")
        ? ""
        : scopes.length === 1
          ? scopes[0]
          : undefined;
    if (scope === undefined) {
      return {
        errors: {
          provider: `기존 계열 ${d.family}의 한정 범위(${scopes.map((p) => p || "전체").join(", ")}) 중 하나여야 합니다`,
        },
      };
    }
    const latest = siblings.find((s) => s.provider === scope)!;
    if (d.match.length && !sameSet(d.match, latest.match)) {
      return {
        errors: {
          match: `기존 계열은 패턴(${latest.match.join(", ") || d.family})을 그대로 씁니다 — 비워 두세요`,
        },
      };
    }
    return { match: latest.match, provider: scope, priority: latest.priority };
  }
  const effective = d.match.length ? d.match : [d.family.toLowerCase()];
  for (const p of effective) {
    if (isRegexPattern(p)) {
      return { errors: { match: "정규식 패턴(/…/)은 등록할 수 없습니다 — 부분 문자열 또는 =정확한이름" } };
    }
    if (!p.startsWith("=") && p.length < 3) {
      return {
        errors: {
          match: d.match.length
            ? `패턴 "${p}"이 너무 짧습니다 (부분 문자열은 3자 이상, 또는 =정확한이름)`
            : `패턴을 비우면 계열 이름 "${p}"이 패턴이 되는데 3자 미만입니다 — 패턴을 입력하세요`,
        },
      };
    }
  }
  if (!d.provider && effective.includes("=")) {
    return { errors: { match: "빈 모델명(=)을 잡는 패턴은 공급자·도구를 한정해야 합니다" } };
  }
  return { match: d.match, provider: d.provider, priority: newFamilyPriority(effective) };
}

// How far back a member registration may start (controller Ruling R25): a
// price version re-prices every usage day from effectiveFrom on, so an old
// start date would silently rewrite long-settled history. Older corrections
// go through the seed (code review), not the form.
export const MAX_BACKDATE_DAYS = 90;

// Validates and stores one price version. registeredBy = the signed-in
// viewer's email (resolved by the caller — never taken from the form).
// opts.today (KST YYYY-MM-DD) is a test seam; production uses todayKst().
export async function registerPrice(
  input: unknown,
  registeredBy: string,
  opts: { today?: string } = {},
): Promise<RegisterResult> {
  const parsed = priceInputSchema.safeParse(input);
  if (!parsed.success) {
    const errors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = String(issue.path[0] ?? "form");
      errors[key] ??= issue.message;
    }
    return { ok: false, errors };
  }
  if (!registeredBy) return { ok: false, errors: { form: "등록자를 확인할 수 없습니다" } };
  const d = parsed.data;
  const earliest = addDays(opts.today ?? todayKst(), -MAX_BACKDATE_DAYS);
  if (d.effectiveFrom < earliest) {
    return {
      ok: false,
      errors: {
        effectiveFrom: `적용 시작일은 ${earliest} 이후여야 합니다 (오늘로부터 ${MAX_BACKDATE_DAYS}일 이내). 더 오래된 기간의 단가 정정은 관리자에게 요청하세요.`,
      },
    };
  }
  await ready();
  await ensureSeeded(); // a first registration must not suppress the seed
  const resolved = await resolveFamily(d);
  if ("errors" in resolved) return { ok: false, errors: resolved.errors };
  const { match, provider, priority } = resolved;
  const duplicate = {
    ok: false,
    errors: {
      effectiveFrom: "같은 계열·공급자·적용 시작일의 단가가 이미 있습니다 (새 적용일로 등록하세요)",
    },
  };
  if (await ModelPriceModel.exists({ provider, family: d.family, effectiveFrom: d.effectiveFrom })) {
    return duplicate;
  }
  try {
    await ModelPriceModel.create({ ...d, match, provider, priority, registeredBy });
  } catch (err) {
    if (isDuplicateKey(err)) return duplicate; // lost a race with a concurrent registration
    throw err;
  }
  return {
    ok: true,
    message: `${d.family}${provider ? ` (${provider})` : ""} · ${d.effectiveFrom}부터 단가를 등록했습니다.`,
  };
}

// ---- deletion -----------------------------------------------------------------

export type PriceKey = { provider: string; family: string; effectiveFrom: string };

// A member may delete only a price version THEY registered (registeredBy ===
// their email). Seed rows are never deletable here — seedMissing would bring
// them back on the next process start anyway; retire a seed price with a newer
// version instead. The key is the unique (provider, family, effectiveFrom).
export async function deletePrice(key: PriceKey, viewerEmail: string): Promise<RegisterResult> {
  if (!viewerEmail) return { ok: false, message: "로그인이 필요합니다" };
  const k = {
    provider: String(key.provider ?? ""),
    family: String(key.family ?? ""),
    effectiveFrom: String(key.effectiveFrom ?? ""),
  };
  if (!k.family || !DATE_RE.test(k.effectiveFrom)) {
    return { ok: false, message: "삭제할 단가를 찾을 수 없습니다" };
  }
  await ready();
  const doc = await ModelPriceModel.findOne(k).lean();
  if (!doc) return { ok: false, message: "삭제할 단가를 찾을 수 없습니다 (이미 삭제됐을 수 있습니다)" };
  if (doc.registeredBy === "seed" || SEED_PRICES.some((e) => e.provider === k.provider && e.family === k.family && e.effectiveFrom === k.effectiveFrom)) {
    return { ok: false, message: "기본(seed) 단가는 삭제할 수 없습니다 — 새 적용 시작일의 단가를 등록하세요" };
  }
  if (doc.registeredBy !== viewerEmail) {
    return { ok: false, message: "본인이 등록한 단가만 삭제할 수 있습니다" };
  }
  // Owner re-checked in the filter: a concurrent edit can't widen the delete.
  const res = await ModelPriceModel.deleteOne({ ...k, registeredBy: viewerEmail });
  if (res.deletedCount !== 1) return { ok: false, message: "삭제할 단가를 찾을 수 없습니다" };
  return {
    ok: true,
    message: `${k.family}${k.provider ? ` (${k.provider})` : ""} · ${k.effectiveFrom} 단가를 삭제했습니다.`,
  };
}

// ---- unpriced ("단가 미정") ---------------------------------------------------

export type UnpricedModel = {
  model: string;
  tool: string;
  // Usage rows have no provider field; the tool is what provider-scoped
  // entries are matched against, so it is reported here as the provider.
  provider: string;
  firstSeen: string; // earliest unpriced day within the range
  tokens: number; // input + output + cache read + cache write (all billable kinds)
};

// Distinct (model, tool) in usage_daily over the range whose tokens have no
// price on the day they were used. Rows without tokens are skipped — there is
// nothing to convert. Largest usage first, then oldest.
export async function listUnpriced(
  range: { from: string; to: string },
  table?: PriceTable,
): Promise<UnpricedModel[]> {
  await connectDb();
  const [t, rows] = await Promise.all([
    table ? Promise.resolve(table) : loadPriceTable(),
    UsageDaily.aggregate<{ _id: { model: string; tool: string; date: string }; tokens: number }>([
      { $match: { date: { $gte: range.from, $lte: range.to } } },
      {
        $group: {
          _id: { model: "$model", tool: "$tool", date: "$date" },
          tokens: {
            $sum: {
              $add: [
                { $ifNull: ["$inputTokens", 0] },
                { $ifNull: ["$outputTokens", 0] },
                { $ifNull: ["$cacheReadTokens", 0] },
                { $ifNull: ["$cacheCreationTokens", 0] },
              ],
            },
          },
        },
      },
      { $match: { tokens: { $gt: 0 } } },
    ]),
  ]);
  const acc = new Map<string, UnpricedModel>();
  for (const r of rows) {
    const model = String(r._id.model ?? "");
    const tool = String(r._id.tool ?? "");
    if (priceFor(t, model, tool, r._id.date)) continue;
    const key = `${tool}\u0000${model}`;
    const cur = acc.get(key);
    if (!cur) {
      acc.set(key, { model, tool, provider: tool, firstSeen: r._id.date, tokens: r.tokens });
    } else {
      cur.tokens += r.tokens;
      if (r._id.date < cur.firstSeen) cur.firstSeen = r._id.date;
    }
  }
  return [...acc.values()].sort(
    (a, b) => b.tokens - a.tokens || a.firstSeen.localeCompare(b.firstSeen),
  );
}
