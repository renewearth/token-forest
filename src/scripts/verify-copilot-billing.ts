import assert from "node:assert/strict";
import {
  collectCopilotReports,
  copilotBillingMode,
  copilotBillingScope,
  copilotBillingUrl,
  copilotReportDays,
  copilotRowsForDay,
  copilotConnector,
  selectCopilotBillingAccounts,
  type CopilotBillingAccount,
} from "@/connectors/copilot";
import { observeField } from "@/lib/observation";

const user: CopilotBillingAccount = { kind: "user", name: "alice", token: "secret-personal" };
const org: CopilotBillingAccount = { kind: "organization", name: "example-org", token: "secret-org" };
const day = "2026-10-01";

function payload(unitType: string, quantity: number, cost: number) {
  return {
    timePeriod: { year: 2026, month: 10, day: 1 },
    usageItems: [{
      product: "Copilot", sku: "Copilot AI Credits", model: "GPT-5",
      unitType, grossQuantity: quantity, netAmount: cost,
    }],
  };
}

async function main() {
  assert.equal(copilotBillingMode("ai_credits"), "ai_credits");
  assert.equal(copilotBillingMode("premium_requests"), "premium_requests");
  assert.throws(() => copilotBillingMode(undefined));
  assert.equal(copilotBillingScope("personal"), "personal");
  assert.equal(copilotBillingScope("organization"), "organization");
  assert.throws(() => copilotBillingScope(undefined));
  assert.throws(() => copilotBillingScope("both"));
  assert.deepEqual(selectCopilotBillingAccounts("personal", [user], org), [user]);
  assert.deepEqual(selectCopilotBillingAccounts("organization", [user], org), [org]);
  assert.throws(() => selectCopilotBillingAccounts("personal", [], org));
  assert.throws(() => selectCopilotBillingAccounts("organization", [user]));
  assert.throws(() => selectCopilotBillingAccounts("organization", [], user));
  assert.deepEqual(copilotReportDays("2026-09-30", day), ["2026-09-30", day]);
  assert.throws(() => copilotReportDays("2026-02-30", day));
  const userUrl = new URL(copilotBillingUrl(user, day, "ai_credits"));
  const orgUrl = new URL(copilotBillingUrl(org, day, "premium_requests"));
  assert.equal(userUrl.pathname, "/users/alice/settings/billing/ai_credit/usage");
  assert.equal(orgUrl.pathname, "/organizations/example-org/settings/billing/premium_request/usage");
  assert.deepEqual(Object.fromEntries(userUrl.searchParams), { year: "2026", month: "10", day: "1" });

  const credits = copilotRowsForDay(payload("credits", 0.25, 0.0025), user, day, "ai_credits");
  assert.equal(credits.length, 1);
  assert.equal(credits[0].periodStart, day);
  assert.equal(credits[0].periodEnd, day);
  assert.equal(credits[0].timeZone, "UTC");
  assert.deepEqual(credits[0].metrics, { ai_credits: 0.25, net_cost_usd: 0.0025 });
  assert.ok(!("reported_requests" in credits[0].metrics));
  const legacy = copilotRowsForDay({
    ...payload("requests", 1.5, 0.06),
    usageItems: [{ ...payload("requests", 1.5, 0.06).usageItems[0], sku: "Copilot Premium Request" }],
  }, org, day, "premium_requests");
  assert.equal(legacy[0].externalId, "org:example-org");
  assert.equal(legacy[0].accountId, "github:organization:example-org");
  assert.equal(legacy[0].metrics.premium_requests, 1.5);
  assert.ok(!("reported_requests" in legacy[0].metrics));
  assert.notEqual(credits[0].product, legacy[0].product);
  assert.throws(() => copilotRowsForDay(payload("requests", 1, 0.04), user, day, "ai_credits"));
  assert.throws(() => copilotRowsForDay({ ...payload("credits", 1, 0.01), timePeriod: { year: 2026, month: 10, day: 2 } }, user, day, "ai_credits"));
  assert.deepEqual(copilotRowsForDay({ timePeriod: { year: 2026, month: 10, day: 1 }, usageItems: [] }, user, day, "ai_credits"), []);
  assert.deepEqual(await copilotConnector.fetchDaily(day), []);

  // Historical monthly-delta rows can have a number in requests. It remains
  // explicitly unsupported for model-call observation.
  assert.deepEqual(observeField({
    date: day, tool: "copilot", model: "", source: "poller", requests: 12,
    inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheCreationTokens: null,
  }, "requests"), { value: null, status: "unsupported", invalid: false });

  const requested: string[] = [];
  const request = (async (url: string | URL | Request) => {
    requested.push(String(url));
    return Response.json(payload("credits", 0.5, 0.005));
  }) as typeof fetch;
  const rows = await collectCopilotReports([user], [day], "ai_credits", request);
  assert.equal(rows.length, 1);
  assert.equal(requested.length, 1);
  assert.equal(rows[0].metrics.ai_credits, 0.5);
  requested.length = 0;
  await collectCopilotReports(selectCopilotBillingAccounts("organization", [user], org), [day], "ai_credits", request);
  assert.equal(requested.length, 1);
  assert.ok(requested[0].includes("/organizations/example-org/"));
  requested.length = 0;
  await collectCopilotReports(selectCopilotBillingAccounts("personal", [user], org), [day], "ai_credits", request);
  assert.equal(requested.length, 1);
  assert.ok(requested[0].includes("/users/alice/"));

  const failureRequest = (async (url: string | URL | Request) => {
    if (String(url).includes("day=2")) return new Response("secret response body", { status: 403 });
    return Response.json(payload("credits", 0.5, 0.005));
  }) as typeof fetch;
  await assert.rejects(
    collectCopilotReports([user], [day, "2026-10-02"], "ai_credits", failureRequest),
    error => error instanceof Error && /1 account\/day/.test(error.message) &&
      !error.message.includes("secret response body") && !error.message.includes(user.token),
  );
  console.log("verify-copilot-billing: PASS");
}

main().catch(error => { console.error(error); process.exitCode = 1; });
