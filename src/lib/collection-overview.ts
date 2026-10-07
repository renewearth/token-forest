import { z } from "zod";

const count = z.number().int().nonnegative();
const nullableCount = count.nullable().optional().default(null);
const nullableText = z.string().nullable().optional().default(null);
const parser = z.object({ parser: z.string(), accountId: z.string().optional(), records: count.optional(), filesScanned: count.optional(), readErrors: count.optional(), linesUnrecognized: count.optional(), error: z.string().optional() });
export const collectionOverviewSchema = z.object({
  protocolVersion: z.literal(3), scope: z.literal("authenticated_member"),
  recordCount: count, conflictCount: count, staleChains: count,
  sourceStatus: z.array(z.object({ tool: z.string(), accountId: z.string(), recordCount: count, conflictCount: count,
    lastSourceAt: nullableText, lastReceiptAt: nullableText, unverifiedCount: count,
    namespaceConfigured: z.boolean().nullable().optional(), namespaceVerified: z.boolean().nullable().optional(), healthStatus: nullableText })),
  deviceStatus: z.array(z.object({ machineId: z.string(), label: nullableText, lastReceiptAt: nullableText,
    pending: nullableCount, reportedRejected: nullableCount, readErrors: nullableCount, healthStatus: nullableText,
    parserHealth: z.array(parser).optional().default([]),
    sources: z.array(z.object({ tool: z.string(), accountId: z.string(), lastSourceAt: nullableText, lastReceiptAt: nullableText })),
  })),
});
export type CollectionOverview = z.infer<typeof collectionOverviewSchema>;
export const LOCAL_COLLECTION_TOOLS = [
  { id: "claude_code", name: "Claude Code", icon: "Cl" },
  { id: "codex", name: "Codex", icon: "Cx" },
  { id: "gemini", name: "Gemini CLI", icon: "Ge" },
  { id: "grok", name: "Grok 래퍼", icon: "Gr" },
  { id: "opencode", name: "OpenCode", icon: "Oc" },
] as const;
function latest(values: Array<string | null>): string | null { return values.filter((v): v is string => !!v).sort().at(-1) ?? null; }

export function buildToolCollectionRows(data: CollectionOverview) {
  return LOCAL_COLLECTION_TOOLS.map((tool) => {
    const sources = data.sourceStatus.filter((s) => s.tool === tool.id);
    const devices = data.deviceStatus.filter((d) => d.sources.some((s) => s.tool === tool.id) || d.parserHealth.some((p) => p.parser === tool.id));
    const parsers = devices.flatMap((d) => d.parserHealth.filter((p) => p.parser === tool.id));
    const records = sources.reduce((n, s) => n + s.recordCount, 0);
    const conflicts = sources.reduce((n, s) => n + s.conflictCount, 0);
    const errors = parsers.some((p) => p.error || p.readErrors || p.linesUnrecognized) || sources.some((s) => s.healthStatus === "error" || s.healthStatus === "partial");
    const unverified = sources.some((s) => s.unverifiedCount > 0 || s.namespaceVerified !== true);
    const label = conflicts ? "기록 충돌 확인" : errors ? "읽기 오류 확인" : !sources.length && !devices.length ? "수신 이력 미확인" : !records ? "원본 범위 확인" : unverified ? "기록 수신 · 대조 필요" : "기록 수신";
    const next = conflicts ? "같은 원천 기록의 개정·수치가 다른지 확인해 주세요. 충돌 기록은 자동으로 합산하지 않습니다."
      : errors ? "아래 기기의 읽기·해석 오류를 확인해 주세요. 다른 기기가 정상이어도 이 오류가 해소된 것은 아닙니다."
      : !records ? "이 도구의 원본 경로와 수집 연결을 확인해 주세요. 기록이 없다는 사실만으로 사용량 0을 판단하지 않습니다."
      : "등록한 계정·기기의 원천 목록과 서버 기록을 대조해 주세요. 최근 수신만으로 빠짐없는 수집을 확인할 수는 없습니다.";
    return { ...tool, sources, devices, records, conflicts, label, next, attention: !!conflicts || errors,
      lastSourceAt: latest(sources.map((s) => s.lastSourceAt)),
      // A heartbeat (even one reporting another tool) is not a record receipt.
      lastReceiptAt: latest(devices.flatMap((d) => d.sources.filter((s) => s.tool === tool.id).map((s) => s.lastReceiptAt))) };
  });
}

export function formatCollectionTime(value: string | null): string {
  if (!value || !Number.isFinite(Date.parse(value))) return "미확인";
  const date = new Date(Date.parse(value) + 9 * 3600000).toISOString();
  return `${date.slice(0, 10)} ${date.slice(11, 16)} KST`;
}
