import { NextResponse } from "next/server";
import { getViewer } from "@/lib/auth";
import { getMyMachines } from "@/lib/queries";

// Install-detection polling for the onboarding wizard: returns the caller's
// uploading machines (v2 Device docs + legacy uploader machines). The wizard
// polls every 10s and flips to "connected" when a new machineId appears — no
// manual "did it work?" guessing.
export async function GET() {
  const viewer = await getViewer();
  if (viewer.status !== "member") {
    return NextResponse.json({ error: "member only" }, { status: 401 });
  }
  const machines = await getMyMachines(viewer.member.email);
  return NextResponse.json({ machines });
}
