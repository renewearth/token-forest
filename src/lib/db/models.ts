import mongoose, { Schema, type Model, type Types } from "mongoose";

// Field semantics mirror the original relational schema: usage_daily holds
// DAILY TOTALS per (date, tool, model, externalId) — upserts replace, never add.

export interface MemberDoc {
  _id: Types.ObjectId;
  name: string;
  email: string;
  ingestToken?: string | null;
  githubTokenEnc?: string | null;
  // Onboarding wizard state: which tools this member said they use (free
  // strings — includes custom tools like "opencode"), and when they finished
  // (or explicitly skipped through) the wizard. null = wizard not completed.
  toolPrefs: string[];
  onboardedAt: Date | null;
  // Roster-visibility flag. Some Member docs exist only to author content (the
  // "AX 리포트" account publishes /knowhow posts) and have no usage of their
  // own. hidden:true keeps them out of the user-facing roster (member list,
  // team adoption/inactive/matrix, home forest) while their authored posts
  // still render. Absent/false = a normal, visible member.
  hidden?: boolean;
  createdAt: Date;
}

export interface MemberIdentityDoc {
  _id: Types.ObjectId;
  memberId: Types.ObjectId;
  tool: string;
  externalId: string;
}

export interface UsageDailyDoc {
  _id: Types.ObjectId;
  date: string; // YYYY-MM-DD (UTC)
  tool: string; // open set: cursor, claude_code, codex, copilot, ...
  model: string; // "" when the source has no model breakdown
  externalId: string;
  machineId: string; // "" for pollers; uploader sends a hostname
  memberId: Types.ObjectId | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  requests: number | null;
  sessions: number | null;
  costEstimateCents: number | null;
  source: string; // poller | uploader | manual
  raw: unknown;
  updatedAt: Date;
}

export interface SyncRunDoc {
  _id: Types.ObjectId;
  tool: string;
  lastSyncedDate: string | null; // last day fully covered by the sync
  status: string; // ok | error
  message: string | null;
  ranAt: Date;
}

// Cross-instance once-only marker. The in-process cron (instrumentation.ts) is
// scheduled by EVERY running server instance, so a job with side effects (the
// weekly Slack report) fires once per instance. A row here, guarded by the
// unique index on `key`, lets exactly one instance claim a job and the rest
// skip. See src/lib/cron.ts.
export interface CronMarkerDoc {
  _id: Types.ObjectId;
  key: string;
  createdAt: Date;
}

// ADDITIVE, hour-grained mirror of usage_daily written only by hour-capable
// sources (claude_code uploader, Cursor, Copilot). Used solely by the time-of-day
// heatmap / hourly drill-down and NEVER summed with usage_daily.
export interface UsageHourlyDoc {
  _id: Types.ObjectId;
  hour: string; // "YYYY-MM-DDTHH" (UTC)
  tool: string;
  model: string;
  externalId: string;
  machineId: string;
  memberId: Types.ObjectId | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  requests: number | null;
  source: string;
  updatedAt: Date;
}

// One row per (date, member, Claude account, rate-limit window). A member may
// own several Claude accounts (1:N), distinguished by accountEmail. Lives in
// its own collection so plan-limit percentages never leak into usage totals.
export interface LimitSnapshotDoc {
  _id: Types.ObjectId;
  date: string; // YYYY-MM-DD (UTC) the snapshot was taken
  memberId: Types.ObjectId; // the authenticated member who owns the account
  accountEmail: string; // Claude account identity (from OAuth profile)
  organization: string; // plan context — one email can hold several plans
  window: string; // five_hour | seven_day | seven_day_opus | ...
  utilizationPct: number;
  // Highest utilization seen that day. utilizationPct is last-write-wins per
  // (date,…) row, so capacity planning needs the peak preserved separately.
  peakPct: number;
  subscriptionType: string | null;
  rateLimitTier: string | null;
  resetsAt: string | null;
  raw: unknown;
  updatedAt: Date;
}

// One private daily work digest per (date, member). Drafted by the uploader,
// reviewed and shared (or skipped) by the member on /me. Trust contract:
// drafts are visible to their owner only until the member explicitly shares.
export interface DigestDoc {
  _id: Types.ObjectId;
  date: string; // YYYY-MM-DD (the day being summarized)
  memberId: Types.ObjectId;
  content: string;
  materials: string; // raw titles/commits shown behind a disclosure
  touchedFiles: Array<{ repo: string; files: string[] }>;
  // Machines whose material is already merged into this draft — lets a
  // member's second machine add its own material instead of being locked out
  // by whichever machine generated first.
  machines: string[];
  status: "draft" | "shared" | "skipped";
  // Once the member edits or resolves a draft, the uploader must never
  // overwrite it — the human's version always wins.
  editedByMember: boolean;
  sharedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface PostDoc {
  _id: Types.ObjectId;
  source: "member" | "ingest";
  title: string;
  bodyMarkdown: string;
  link: string | null;
  tags: string[];
  authorMemberId: Types.ObjectId;
  activityAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface ReactionDoc {
  _id: Types.ObjectId;
  postId: Types.ObjectId;
  memberId: Types.ObjectId;
  emoji: string;
  createdAt: Date;
}

const memberSchema = new Schema<MemberDoc>(
  {
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true },
    // Per-member bearer token for POST /api/ingest (uploader CLI, manual tools)
    ingestToken: { type: String, unique: true, sparse: true },
    // AES-256-GCM encrypted GitHub token with "Plan: read" (Copilot personal)
    githubTokenEnc: { type: String, default: null },
    toolPrefs: { type: [String], default: [] },
    onboardedAt: { type: Date, default: null },
    hidden: { type: Boolean, default: false },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

// Shared filter for every query that enumerates the roster for display. Apply
// to the Member.find()/countDocuments() call, NOT to usage aggregations (those
// join back to members by id and never surface a hidden, usage-less account).
export const VISIBLE_MEMBER = { hidden: { $ne: true } } as const;

// Maps a tool-native user identifier (cursor email, github
// username, ...) to a member. New tools only need new documents.
const memberIdentitySchema = new Schema<MemberIdentityDoc>({
  memberId: { type: Schema.Types.ObjectId, ref: "Member", required: true },
  tool: { type: String, required: true },
  externalId: { type: String, required: true },
});
memberIdentitySchema.index({ tool: 1, externalId: 1 }, { unique: true });

const usageDailySchema = new Schema<UsageDailyDoc>(
  {
    date: { type: String, required: true },
    tool: { type: String, required: true },
    model: { type: String, default: "" },
    externalId: { type: String, required: true },
    machineId: { type: String, default: "" },
    // Denormalized from member_identities; may lag until a mapping is
    // registered — externalId is the source of truth for identity.
    memberId: { type: Schema.Types.ObjectId, ref: "Member", default: null },
    inputTokens: { type: Number, default: null },
    outputTokens: { type: Number, default: null },
    cacheReadTokens: { type: Number, default: null },
    cacheCreationTokens: { type: Number, default: null },
    requests: { type: Number, default: null },
    sessions: { type: Number, default: null },
    costEstimateCents: { type: Number, default: null },
    source: { type: String, required: true },
    raw: { type: Schema.Types.Mixed, default: null },
  },
  { timestamps: { createdAt: false, updatedAt: true } },
);
usageDailySchema.index(
  { date: 1, tool: 1, model: 1, externalId: 1, machineId: 1 },
  { unique: true },
);
usageDailySchema.index({ tool: 1, date: 1 });
usageDailySchema.index({ memberId: 1, date: 1 });
usageDailySchema.index({ date: 1 });

const usageHourlySchema = new Schema<UsageHourlyDoc>(
  {
    hour: { type: String, required: true },
    tool: { type: String, required: true },
    model: { type: String, default: "" },
    externalId: { type: String, required: true },
    machineId: { type: String, default: "" },
    memberId: { type: Schema.Types.ObjectId, ref: "Member", default: null },
    inputTokens: { type: Number, default: null },
    outputTokens: { type: Number, default: null },
    cacheReadTokens: { type: Number, default: null },
    cacheCreationTokens: { type: Number, default: null },
    requests: { type: Number, default: null },
    source: { type: String, required: true },
  },
  { timestamps: { createdAt: false, updatedAt: true } },
);
usageHourlySchema.index(
  { hour: 1, tool: 1, model: 1, externalId: 1, machineId: 1 },
  { unique: true },
);
usageHourlySchema.index({ memberId: 1, hour: 1 });
usageHourlySchema.index({ hour: 1 });

const limitSnapshotSchema = new Schema<LimitSnapshotDoc>(
  {
    date: { type: String, required: true },
    memberId: { type: Schema.Types.ObjectId, ref: "Member", required: true },
    accountEmail: { type: String, required: true },
    organization: { type: String, default: "" },
    window: { type: String, required: true },
    utilizationPct: { type: Number, required: true },
    peakPct: { type: Number, default: 0 },
    subscriptionType: { type: String, default: null },
    rateLimitTier: { type: String, default: null },
    resetsAt: { type: String, default: null },
    raw: { type: Schema.Types.Mixed, default: null },
  },
  { timestamps: { createdAt: false, updatedAt: true } },
);
limitSnapshotSchema.index(
  { date: 1, memberId: 1, accountEmail: 1, organization: 1, window: 1 },
  { unique: true },
);
limitSnapshotSchema.index({ memberId: 1, date: -1 });

const digestSchema = new Schema<DigestDoc>(
  {
    date: { type: String, required: true },
    memberId: { type: Schema.Types.ObjectId, ref: "Member", required: true },
    content: { type: String, required: true },
    materials: { type: String, default: "" },
    touchedFiles: {
      type: [
        new Schema(
          { repo: { type: String, required: true }, files: { type: [String], default: [] } },
          { _id: false },
        ),
      ],
      default: [],
    },
    machines: { type: [String], default: [] },
    status: {
      type: String,
      enum: ["draft", "shared", "skipped"],
      default: "draft",
    },
    // Human-edited or resolved documents are immutable to the uploader.
    editedByMember: { type: Boolean, default: false },
    sharedAt: { type: Date, default: null },
  },
  { timestamps: true },
);
digestSchema.index({ date: 1, memberId: 1 }, { unique: true });

// Incremental-sync cursor per connector.
const syncRunSchema = new Schema<SyncRunDoc>(
  {
    tool: { type: String, required: true },
    lastSyncedDate: { type: String, default: null },
    status: { type: String, required: true },
    message: { type: String, default: null },
  },
  { timestamps: { createdAt: "ranAt", updatedAt: false } },
);
syncRunSchema.index({ tool: 1, status: 1, _id: -1 });

const cronMarkerSchema = new Schema<CronMarkerDoc>(
  { key: { type: String, required: true, unique: true } },
  { timestamps: { createdAt: true, updatedAt: false } },
);

const postSchema = new Schema<PostDoc>(
  {
    source: { type: String, enum: ["member", "ingest"], required: true },
    title: { type: String, required: true },
    bodyMarkdown: { type: String, default: "" },
    link: { type: String, default: null },
    tags: { type: [String], default: [] },
    authorMemberId: { type: Schema.Types.ObjectId, ref: "Member", required: true },
    activityAt: { type: Date, required: true },
  },
  { timestamps: true },
);
postSchema.index({ activityAt: -1 });
// 인제스트 멱등 조회: 같은 멤버·링크 재주입 시 update.
postSchema.index({ authorMemberId: 1, link: 1 });

const reactionSchema = new Schema<ReactionDoc>(
  {
    postId: { type: Schema.Types.ObjectId, ref: "Post", required: true },
    memberId: { type: Schema.Types.ObjectId, ref: "Member", required: true },
    emoji: { type: String, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
reactionSchema.index({ postId: 1, memberId: 1, emoji: 1 }, { unique: true });
reactionSchema.index({ postId: 1 });

// Hot-reload-safe model registration (Next dev recompiles modules).
function model<T>(name: string, schema: Schema<T>): Model<T> {
  return (mongoose.models[name] as Model<T>) ?? mongoose.model<T>(name, schema);
}

export const Member = model("Member", memberSchema);
export const MemberIdentity = model("MemberIdentity", memberIdentitySchema);
export const UsageDaily = model("UsageDaily", usageDailySchema);
export const UsageHourly = model("UsageHourly", usageHourlySchema);
export const LimitSnapshot = model("LimitSnapshot", limitSnapshotSchema);
export const Digest = model("Digest", digestSchema);
export const SyncRun = model("SyncRun", syncRunSchema);
export const CronMarker = model("CronMarker", cronMarkerSchema);
export const Post = model("Post", postSchema);
export const Reaction = model("Reaction", reactionSchema);
