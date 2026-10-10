import { NextRequest, NextResponse } from "next/server";
import { connectDb, Member } from "@/lib/db";
import { handleIngest } from "@/lib/ingest";
import { ingestPayloadSchema } from "@/lib/types";

// Universal ingestion endpoint: uploader CLI, manual entry, any future tool
// without a central API. Auth: per-member bearer token (members.ingestToken).
// Accepts the v1 payload (rows + hourly, old uploaders) and the v2 payload
// (sessions + health + device); the body lives in src/lib/ingest.ts. Response
// keeps the v1 fields (upserted, skipped, hourlyUpserted) and adds
// sessionsUpserted + derived — old uploaders ignore unknown fields.
export async function POST(req: NextRequest) {
  const auth = req.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) {
    return NextResponse.json({ error: "missing bearer token" }, { status: 401 });
  }
  await connectDb();
  const member = await Member.findOne({ ingestToken: token }).lean();
  if (!member) {
    return NextResponse.json({ error: "invalid token" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const parsed = ingestPayloadSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid payload", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const result = await handleIngest(member, parsed.data);
  return NextResponse.json({ ok: true, ...result });
}
