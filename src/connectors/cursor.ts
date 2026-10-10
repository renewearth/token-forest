import type { Connector } from "./types";
import type { UsageHourlyRow, UsageRow } from "@/lib/types";

// Cursor Admin API connector.
// Docs: https://cursor.com/docs/account/teams/admin-api
// Auth (both endpoints): HTTP Basic, API key as username with an empty password.
//
// This connector reads two endpoints and emits two kinds of rows that never
// collide on the (date, tool, model, externalId) unique key:
//
//   1. POST /teams/daily-usage-data — per user-day activity. Emitted with
//      model="" carrying request counts / activity only (no token data; this
//      endpoint does not report tokens).
//   2. POST /teams/filtered-usage-events — per-event token usage. Aggregated
//      into (date, userEmail, model) rows carrying the four token counts and
//      costEstimateCents (sum of tokenUsage.totalCents). model is the real
//      model name here, so these never share a key with the model="" rows.

const DAILY_URL = "https://api.cursor.com/teams/daily-usage-data";
const EVENTS_URL = "https://api.cursor.com/teams/filtered-usage-events";
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_WINDOW_MS = 30 * DAY_MS; // daily-usage-data caps a request at 30 days.
const EVENTS_PAGE_SIZE = 1000; // filtered-usage-events max pageSize.

// --- daily-usage-data types (only consumed fields typed) ---
interface CursorUsageDay {
  userId?: number;
  day?: string; // ISO date, e.g. "2025-09-08" (or a full ISO datetime)
  date?: number; // epoch ms for `day`
  email?: string;
  isActive?: boolean;
  composerRequests?: number;
  chatRequests?: number;
  agentRequests?: number;
  cmdkUsages?: number;
  [key: string]: unknown;
}

interface CursorUsageResponse {
  data?: CursorUsageDay[];
}

// --- filtered-usage-events types ---
interface CursorTokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheWriteTokens?: number;
  cacheReadTokens?: number;
  totalCents?: number;
}

interface CursorUsageEvent {
  timestamp?: string; // epoch milliseconds, as a string
  userEmail?: string;
  model?: string;
  isTokenBasedCall?: boolean;
  tokenUsage?: CursorTokenUsage; // present only when isTokenBasedCall is true
  [key: string]: unknown;
}

interface CursorEventsResponse {
  usageEvents?: CursorUsageEvent[];
  pagination?: { hasNextPage?: boolean };
}

function authHeader(apiKey: string): string {
  // Basic auth: base64("<apiKey>:") — key as username, empty password.
  return `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}`;
}

function startOfDayUtcMs(dateStr: string): number {
  return Date.parse(`${dateStr}T00:00:00.000Z`);
}

// Normalize daily-usage-data's `day`/`date` into a YYYY-MM-DD (UTC) string.
function dayToDateString(row: CursorUsageDay): string | null {
  if (typeof row.day === "string" && row.day.length >= 10) {
    return row.day.slice(0, 10);
  }
  if (typeof row.date === "number") {
    return new Date(row.date).toISOString().slice(0, 10);
  }
  return null;
}

function sumRequests(row: CursorUsageDay): number | null {
  const parts = [
    row.composerRequests,
    row.chatRequests,
    row.agentRequests,
    row.cmdkUsages,
  ];
  if (parts.every((p) => typeof p !== "number")) return null;
  return parts.reduce<number>(
    (acc, p) => acc + (typeof p === "number" ? p : 0),
    0,
  );
}

async function postJson<T>(
  url: string,
  apiKey: string,
  body: Record<string, unknown>,
): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: authHeader(apiKey),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Cursor ${url} failed: ${res.status} ${res.statusText}${
        text ? ` — ${text}` : ""
      }`,
    );
  }
  return (await res.json()) as T;
}

// --- daily-usage-data → activity rows (model="") ---
async function fetchActivityRows(
  apiKey: string,
  since: string,
  now: number,
): Promise<UsageRow[]> {
  const rows: UsageRow[] = [];
  for (
    let windowStart = startOfDayUtcMs(since);
    windowStart <= now;
    windowStart += MAX_WINDOW_MS
  ) {
    const windowEnd = Math.min(windowStart + MAX_WINDOW_MS - 1, now);
    const json = await postJson<CursorUsageResponse>(DAILY_URL, apiKey, {
      startDate: windowStart,
      endDate: windowEnd,
    });
    for (const day of json.data ?? []) {
      if (day.isActive === false) continue;
      const date = dayToDateString(day);
      const email = day.email;
      const requests = sumRequests(day);
      if (!date || !email || requests === null) continue;
      rows.push({
        date,
        tool: "cursor",
        model: "", // activity row; token/cost live on the per-model rows
        externalId: email,
        requests,
        source: "poller",
        dateBasis: "UTC",
        raw: day,
      });
    }
  }
  return rows;
}

// Token counts accumulated for one bucket (date-grained or hour-grained).
interface TokenAgg {
  bucket: string; // the UTC date or hour string this agg is keyed on
  email: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costCents: number;
}

// A token-based usage event, decoded to the fields both aggregations consume.
interface TokenEvent {
  tsMs: number;
  email: string;
  model: string;
  usage: CursorTokenUsage;
}

// Stream every token-based filtered-usage-event from `since` to `now`, one
// event at a time, handling both the 30-day window chunking and the page
// cursor. Both the daily and hourly aggregations iterate this same source so
// the pagination lives in one place.
async function* iterateTokenEvents(
  apiKey: string,
  since: string,
  now: number,
): AsyncGenerator<TokenEvent> {
  for (
    let windowStart = startOfDayUtcMs(since);
    windowStart <= now;
    windowStart += MAX_WINDOW_MS
  ) {
    const windowEnd = Math.min(windowStart + MAX_WINDOW_MS - 1, now);
    for (let page = 1; ; page++) {
      const json = await postJson<CursorEventsResponse>(EVENTS_URL, apiKey, {
        startDate: windowStart,
        endDate: windowEnd,
        page,
        pageSize: EVENTS_PAGE_SIZE,
      });

      for (const ev of json.usageEvents ?? []) {
        const usage = ev.tokenUsage;
        const email = ev.userEmail;
        const tsMs = ev.timestamp ? Number(ev.timestamp) : NaN;
        // tokenUsage is only present for token-based calls; skip the rest.
        if (!usage || !email || !Number.isFinite(tsMs)) continue;
        yield {
          tsMs,
          email,
          // "" would collide with the daily-usage-data activity rows on the
          // (date, tool, model, externalId) upsert key.
          model: ev.model || "unknown",
          usage,
        };
      }

      if (!json.pagination?.hasNextPage) break;
    }
  }
}

// Fold token events into per-bucket aggregates. `bucketOf` maps an event's
// epoch ms to the bucket string (UTC date for daily, UTC hour for hourly).
async function aggregateTokens(
  apiKey: string,
  since: string,
  now: number,
  bucketOf: (tsMs: number) => string,
): Promise<TokenAgg[]> {
  const buckets = new Map<string, TokenAgg>();
  for await (const ev of iterateTokenEvents(apiKey, since, now)) {
    const bucket = bucketOf(ev.tsMs);
    const key = `${bucket} ${ev.email} ${ev.model}`;
    let agg = buckets.get(key);
    if (!agg) {
      agg = {
        bucket,
        email: ev.email,
        model: ev.model,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costCents: 0,
      };
      buckets.set(key, agg);
    }
    agg.inputTokens += ev.usage.inputTokens ?? 0;
    agg.outputTokens += ev.usage.outputTokens ?? 0;
    agg.cacheReadTokens += ev.usage.cacheReadTokens ?? 0;
    agg.cacheCreationTokens += ev.usage.cacheWriteTokens ?? 0;
    agg.costCents += ev.usage.totalCents ?? 0;
  }
  return Array.from(buckets.values());
}

// --- filtered-usage-events → per-model token rows (daily) ---
async function fetchTokenRows(
  apiKey: string,
  since: string,
  now: number,
): Promise<UsageRow[]> {
  const aggs = await aggregateTokens(apiKey, since, now, (tsMs) =>
    new Date(tsMs).toISOString().slice(0, 10),
  );
  return aggs.map((agg) => ({
    date: agg.bucket,
    tool: "cursor",
    model: agg.model,
    externalId: agg.email,
    inputTokens: agg.inputTokens,
    outputTokens: agg.outputTokens,
    cacheReadTokens: agg.cacheReadTokens,
    cacheCreationTokens: agg.cacheCreationTokens,
    // Request counts live on the model="" activity row; keep them off the
    // token rows so aggregating both kinds doesn't double-count requests.
    costEstimateCents: agg.costCents,
    source: "poller" as const,
    dateBasis: "UTC" as const,
  }));
}

// --- filtered-usage-events → per-model token rows (hourly) ---
// The additive usage_hourly mirror: same events as fetchTokenRows, bucketed by
// UTC hour instead of day. Only token rows (real model names) are emitted; the
// activity rows carry no tokens and the heatmap is token-based, so they have no
// hourly counterpart. costEstimateCents is daily-only, so it is dropped here.
async function fetchTokenHourlyRows(
  apiKey: string,
  since: string,
  now: number,
): Promise<UsageHourlyRow[]> {
  const aggs = await aggregateTokens(apiKey, since, now, (tsMs) =>
    new Date(tsMs).toISOString().slice(0, 13),
  );
  return aggs.map((agg) => ({
    hour: agg.bucket,
    tool: "cursor",
    model: agg.model,
    externalId: agg.email,
    inputTokens: agg.inputTokens,
    outputTokens: agg.outputTokens,
    cacheReadTokens: agg.cacheReadTokens,
    cacheCreationTokens: agg.cacheCreationTokens,
    source: "poller" as const,
    dateBasis: "UTC" as const,
  }));
}

export const cursorConnector: Connector = {
  tool: "cursor",
  lookbackDays: 2,

  async fetchDaily(since: string): Promise<UsageRow[]> {
    const apiKey = process.env.CURSOR_API_KEY;
    if (!apiKey) {
      throw new Error(
        "CURSOR_API_KEY is not set — required for the Cursor connector.",
      );
    }

    const now = Date.now();
    const [activityRows, tokenRows] = await Promise.all([
      fetchActivityRows(apiKey, since, now),
      fetchTokenRows(apiKey, since, now),
    ]);
    return [...activityRows, ...tokenRows];
  },

  // Hour-grained token rows for usage_hourly. Independent of fetchDaily, so it
  // re-reads filtered-usage-events (the endpoint returns per-event rows; there
  // is no server-side hourly rollup to reuse).
  async fetchHourly(since: string): Promise<UsageHourlyRow[]> {
    const apiKey = process.env.CURSOR_API_KEY;
    if (!apiKey) {
      throw new Error(
        "CURSOR_API_KEY is not set — required for the Cursor connector.",
      );
    }
    return fetchTokenHourlyRows(apiKey, since, Date.now());
  },
};
