// Claude spend report CSV parsing (src/lib/report-import.ts): channel-split
// lines and the cache breakdown columns. No database, no network.
//   ./node_modules/.bin/tsx src/scripts/verify-claude-spend-csv.ts
import assert from "node:assert/strict";
import { parseClaudeSpendCsv } from "@/lib/report-import";
import { REPORT_METRICS, REPORT_METRIC_LABELS } from "@/lib/usage-report-types";

let checks = 0;
function check(fn: () => void) { fn(); checks++; }

const context = { accountId: "synthetic-org", periodStart: "2026-07-11", periodEnd: "2026-10-09", timeZone: "UTC", coverage: "unknown" as const };
// Column order of the real export. All values below are made up.
const HEADER = "user_email,account_uuid,product,model,total_requests,total_prompt_tokens,total_completion_tokens,total_net_spend_usd,total_gross_spend_usd,user_id,total_uncached_input_tokens,total_cache_read_tokens,total_cache_write_5m_tokens,total_cache_write_1h_tokens,total_web_search_count,slack_channel_id,teams_channel_id";
const line = (o: { email?: string; product: string; model?: string; req: number; uncached: number; read: number; w5: number; w1: number; out: number; usd?: string; slack?: string; teams?: string; prompt?: number }) =>
  [o.email ?? "one@example.test", "acct-1", o.product, o.model ?? "claude-sonnet-5", o.req, o.prompt ?? o.uncached + o.read + o.w5 + o.w1, o.out, o.usd ?? "0", o.usd ?? "0", "user-1", o.uncached, o.read, o.w5, o.w1, 0, o.slack ?? "", o.teams ?? ""].join(",");
const csv = (...lines: string[]) => [HEADER, ...lines].join("\n") + "\n";

function main() {
  // Cache breakdown columns are read; the two cache-write columns are summed.
  const one = parseClaudeSpendCsv(csv(line({ product: "Chat", req: 3, uncached: 10, read: 200, w5: 30, w1: 4, out: 50, usd: "1.5" })), context);
  check(() => assert.equal(one.length, 1));
  check(() => assert.deepEqual(one[0].metrics, { reported_requests: 3, prompt_tokens: 244, completion_tokens: 50, net_cost_usd: 1.5, uncached_input_tokens: 10, cache_read_tokens: 200, cache_write_tokens: 34 }));
  check(() => assert.equal(one[0].externalId, "one@example.test"));

  // Lines that differ only by channel are summed into one row.
  const tag = parseClaudeSpendCsv(csv(
    line({ product: "Claude Tag", req: 2, uncached: 1, read: 10, w5: 2, w1: 0, out: 5, usd: "0.25", slack: "C1" }),
    line({ product: "Claude Tag", req: 3, uncached: 2, read: 20, w5: 0, w1: 3, out: 7, usd: "0.5", slack: "C2" }),
    line({ product: "Claude Tag", req: 1, uncached: 4, read: 40, w5: 1, w1: 1, out: 9, teams: "T1" }),
    line({ product: "Claude Tag", model: "claude-opus-5", req: 9, uncached: 9, read: 9, w5: 9, w1: 9, out: 9, slack: "C1" }),
    line({ product: "Chat", req: 4, uncached: 5, read: 6, w5: 7, w1: 8, out: 9 }),
  ), context);
  check(() => assert.equal(tag.length, 3));
  const sonnetTag = tag.find(r => r.product === "Claude Tag" && r.model === "claude-sonnet-5");
  check(() => assert.deepEqual(sonnetTag?.metrics, { reported_requests: 6, prompt_tokens: 84, completion_tokens: 21, net_cost_usd: 0.75, uncached_input_tokens: 7, cache_read_tokens: 70, cache_write_tokens: 7 }));
  check(() => assert.equal(tag.find(r => r.model === "claude-opus-5")?.metrics.reported_requests, 9));
  check(() => assert.equal(tag.find(r => r.product === "Chat")?.metrics.cache_write_tokens, 15));
  // Channel ids are not persisted anywhere on the row.
  check(() => assert.equal(JSON.stringify(tag).includes("C1"), false));

  // The same channel twice, or no channel on either line, is still a duplicate.
  const dup = line({ product: "Claude Tag", req: 1, uncached: 1, read: 1, w5: 1, w1: 1, out: 1, slack: "C1" });
  check(() => assert.throws(() => parseClaudeSpendCsv(csv(dup, dup), context), /3행: 사용자·제품·모델 범위가 중복/));
  const plain = line({ product: "Chat", req: 1, uncached: 1, read: 1, w5: 1, w1: 1, out: 1 });
  check(() => assert.throws(() => parseClaudeSpendCsv(csv(plain, plain), context), /중복/));
  // Different users on the same product·model stay separate rows.
  check(() => assert.equal(parseClaudeSpendCsv(csv(plain, line({ email: "two@example.test", product: "Chat", req: 1, uncached: 1, read: 1, w5: 1, w1: 1, out: 1 })), context).length, 2));

  // A prompt total that disagrees with the breakdown is kept as reported.
  const odd = parseClaudeSpendCsv(csv(line({ product: "Chat", req: 1, uncached: 10, read: 20, w5: 0, w1: 0, out: 1, prompt: 999 })), context);
  check(() => assert.equal(odd[0].metrics.prompt_tokens, 999));
  check(() => assert.equal(odd[0].metrics.uncached_input_tokens, 10));

  // Older exports without the breakdown or channel columns still parse.
  const legacy = parseClaudeSpendCsv("email,product,model,total_requests,total_prompt_tokens,total_completion_tokens\nold@example.test,Chat,m,2,30,4\n", context);
  check(() => assert.deepEqual(legacy[0].metrics, { reported_requests: 2, prompt_tokens: 30, completion_tokens: 4 }));
  check(() => assert.throws(() => parseClaudeSpendCsv("email,product,model,total_requests,total_prompt_tokens,total_completion_tokens\nold@example.test,Chat,m,2,30,4\nold@example.test,Chat,m,2,30,4\n", context), /중복/));
  // Only one cache-write column present, the other blank.
  const half = parseClaudeSpendCsv(csv(line({ product: "Chat", req: 1, uncached: 1, read: 1, w5: 5, w1: 0, out: 1 }).replace(/,5,0,0,,$/, ",5,,0,,")), context);
  check(() => assert.equal(half[0].metrics.cache_write_tokens, 5));
  // A fractional token count is rejected, as for the existing token columns.
  check(() => assert.throws(() => parseClaudeSpendCsv(csv(line({ product: "Chat", req: 1, uncached: 1, read: 1, w5: 1, w1: 1, out: 1 }).replace(",user-1,1,", ",user-1,1.5,")), context)));
  // Every metric has a display label.
  check(() => assert.deepEqual(REPORT_METRICS.filter(m => !REPORT_METRIC_LABELS[m]), []));

  console.log(`claude spend csv: ${checks} checks passed`);
}
main();
