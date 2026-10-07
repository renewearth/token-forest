import { NextRequest, NextResponse } from "next/server";
import { memberForStatus } from "@/lib/record-auth";
import { getCollectionStatus } from "@/lib/record-status";

export const dynamic = "force-dynamic";
export async function GET(req: NextRequest) {
  const member = await memberForStatus(req);
  if (!member) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return NextResponse.json(await getCollectionStatus(member._id));
}
