import { NextRequest, NextResponse } from "next/server";
import { memberFromBearer } from "@/lib/record-auth";
import { reconcileRecordReceipts } from "@/lib/record-ingest";

export const dynamic = "force-dynamic";
export async function POST(req: NextRequest) {
  const member = await memberFromBearer(req);
  if (!member) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  let body: unknown;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "invalid JSON" }, { status: 400 }); }
  const result = await reconcileRecordReceipts(member, body);
  return NextResponse.json(result.body, { status: result.httpStatus });
}
