import { z } from "zod";

export const reportDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(
  value => !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value,
  "유효한 날짜가 필요합니다",
);
export const REPORT_METRICS = ["prompt_tokens", "completion_tokens", "reported_requests", "ai_credits", "premium_requests", "active_uses", "net_cost_usd"] as const;
export type ReportMetric = typeof REPORT_METRICS[number];
const metricShape = Object.fromEntries(REPORT_METRICS.map(key => [key, z.number().finite().nonnegative().optional()])) as Record<ReportMetric, z.ZodOptional<z.ZodNumber>>;
export const usageReportRowSchema = z.object({
  sourceId: z.string().trim().min(1).max(100),
  accountId: z.string().trim().min(1).max(200),
  product: z.string().trim().min(1).max(100),
  externalId: z.string().trim().min(1).max(200),
  model: z.string().max(200).default(""),
  periodStart: reportDateSchema,
  periodEnd: reportDateSchema,
  timeZone: z.string().max(80).refine(value => { try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; } catch { return false; } }, "시간대 확인이 필요합니다"),
  granularity: z.enum(["day", "period"]),
  coverage: z.enum(["full", "overage", "unknown"]),
  metrics: z.object(metricShape).strict().refine(m => Object.values(m).some(v => v !== undefined), "사용량 항목이 없습니다"),
}).strict().superRefine((row, ctx) => {
  if (row.periodEnd < row.periodStart || (row.granularity === "day" && row.periodStart !== row.periodEnd)) {
    ctx.addIssue({ code: "custom", path: ["periodEnd"], message: "보고서 기간을 확인하세요" });
  }
  for (const metric of ["prompt_tokens", "completion_tokens", "reported_requests", "active_uses"] as const) {
    if (row.metrics[metric] !== undefined && !Number.isSafeInteger(row.metrics[metric])) ctx.addIssue({ code: "custom", path: ["metrics", metric], message: "0 이상의 안전한 정수여야 합니다" });
  }
});
export type UsageReportRow = z.infer<typeof usageReportRowSchema>;

export const usageReportSnapshotSchema = z.object({
  sourceId: z.string().min(1).max(100), accountId: z.string().min(1).max(200),
  periodStart: reportDateSchema, periodEnd: reportDateSchema,
  timeZone: z.string().min(1).max(80), granularity: z.enum(["day", "period"]), coverage: z.enum(["full", "overage", "unknown"]),
  partition: z.string().max(120), rows: z.array(usageReportRowSchema).max(5000),
}).strict().superRefine((snapshot, ctx) => {
  // Validate even empty snapshots with the same source/date/zone contract.
  if (snapshot.periodEnd < snapshot.periodStart || (snapshot.granularity === "day" && snapshot.periodStart !== snapshot.periodEnd)) ctx.addIssue({ code: "custom", message: "보고서 기간 오류" });
  try { new Intl.DateTimeFormat("en", { timeZone: snapshot.timeZone }); } catch { ctx.addIssue({ code: "custom", message: "시간대 오류" }); }
  const keys = new Set<string>();
  for (const row of snapshot.rows) {
    for (const field of ["sourceId", "accountId", "periodStart", "periodEnd", "timeZone", "granularity", "coverage"] as const) {
      if (row[field] !== snapshot[field]) ctx.addIssue({ code: "custom", message: "보고서 행과 수집 범위가 다릅니다" });
    }
    const key = JSON.stringify([row.product, row.model, row.externalId]);
    if (keys.has(key)) ctx.addIssue({ code: "custom", message: "같은 범위의 보고서 행이 중복되었습니다" });
    keys.add(key);
  }
});
export type UsageReportSnapshot = z.infer<typeof usageReportSnapshotSchema>;
export function reportSnapshotFor(row: UsageReportRow): UsageReportSnapshot {
  return { sourceId: row.sourceId, accountId: row.accountId, periodStart: row.periodStart, periodEnd: row.periodEnd,
    timeZone: row.timeZone, granularity: row.granularity, coverage: row.coverage,
    partition: row.sourceId === "github-copilot-billing" ? row.product : "", rows: [] };
}

export const REPORT_METRIC_LABELS: Record<ReportMetric, string> = {
  prompt_tokens: "입력 토큰 (보고서 기준)", completion_tokens: "출력 토큰", reported_requests: "보고된 요청 건수",
  ai_credits: "AI 크레딧", premium_requests: "프리미엄 요청 과금량", active_uses: "능동 기능 사용 건수", net_cost_usd: "순비용 (USD)",
};
