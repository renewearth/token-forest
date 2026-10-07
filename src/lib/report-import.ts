import { usageReportRowSchema, type UsageReportRow } from "./usage-report-types";

// RFC 4180 quoting, BOM, CRLF and quoted newlines. No eval, formulas or content
// columns are persisted. Limits apply before parsing.
export function parseReportCsv(text: string): string[][] {
  if (Buffer.byteLength(text, "utf8") > 2_000_000) throw new Error("CSV는 2MB 이하여야 합니다");
  const rows: string[][] = []; let row: string[] = []; let cell = ""; let quoted = false; let closed = false;
  const input = text.replace(/^\uFEFF/, "");
  const flushCell = () => { row.push(cell.trim()); cell = ""; closed = false; };
  const flushRow = () => { flushCell(); if (row.some(v => v !== "")) rows.push(row); row = []; if (rows.length > 5001) throw new Error("CSV는 5000행 이하여야 합니다"); };
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quoted) {
      if (ch === '"') { if (input[i + 1] === '"') { cell += '"'; i++; } else { quoted = false; closed = true; } }
      else cell += ch;
    } else if (ch === '"') { if (cell !== "" || closed) throw new Error("CSV 따옴표 형식 오류"); quoted = true; }
    else if (ch === ",") flushCell();
    else if (ch === "\n" || ch === "\r") { if (ch === "\r" && input[i + 1] === "\n") i++; flushRow(); }
    else { if (closed && !/\s/.test(ch)) throw new Error("CSV 따옴표 뒤 형식 오류"); if (!closed) cell += ch; }
  }
  if (quoted) throw new Error("CSV 따옴표가 닫히지 않았습니다");
  if (cell !== "" || row.length || closed) flushRow();
  return rows;
}

export interface ClaudeReportContext {
  accountId: string; periodStart: string; periodEnd: string; timeZone: string; coverage: "full" | "overage" | "unknown";
}
const aliases: Record<string, string> = {
  "user's email": "email", "user_email": "email", "user email": "email", "email": "email",
  "account uuid": "account_uuid", "account_uuid": "account_uuid", "product": "product", "model": "model",
};
export function parseClaudeSpendCsv(csv: string, context: ClaudeReportContext): UsageReportRow[] {
  const [rawHeaders, ...records] = parseReportCsv(csv);
  if (!rawHeaders || !records.length) throw new Error("보고서에 데이터가 없습니다");
  const headers = rawHeaders.map(h => aliases[h.toLowerCase()] ?? h.toLowerCase());
  if (new Set(headers).size !== headers.length) throw new Error("CSV 열 이름이 중복되었습니다");
  for (const name of ["product", "model", "total_requests", "total_prompt_tokens", "total_completion_tokens"]) {
    if (!headers.includes(name)) throw new Error(`필수 열이 없습니다: ${name}`);
  }
  if (!headers.includes("email") && !headers.includes("account_uuid")) throw new Error("사용자 이메일 또는 account_uuid 열이 필요합니다");
  const keys = new Set<string>();
  return records.map((cells, index) => {
    if (cells.length !== headers.length) throw new Error(`${index + 2}행: 열 개수가 다릅니다`);
    const data = Object.fromEntries(headers.map((h, i) => [h, cells[i]]));
    const metrics: UsageReportRow["metrics"] = {};
    for (const [column, metric] of Object.entries({ total_requests: "reported_requests", total_prompt_tokens: "prompt_tokens", total_completion_tokens: "completion_tokens", total_net_spend_usd: "net_cost_usd" } as const)) {
      const value = data[column];
      if (value === undefined || value === "") continue;
      if (!/^\d+(?:\.\d+)?$/.test(value)) throw new Error(`${index + 2}행: ${column} 숫자 형식 오류`);
      metrics[metric] = Number(value);
    }
    const externalId = data.email?.toLowerCase() || data.account_uuid;
    const row = usageReportRowSchema.parse({ ...context, sourceId: "claude-spend-csv", externalId,
      product: data.product, model: data.model, granularity: "period", metrics });
    const key = JSON.stringify([row.product, row.model, row.externalId]);
    if (keys.has(key)) throw new Error(`${index + 2}행: 사용자·제품·모델 범위가 중복되었습니다`);
    keys.add(key);
    return row;
  });
}
