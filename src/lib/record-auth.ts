import type { NextRequest } from "next/server";
import { connectDb, Member } from "@/lib/db";
import { SESSION_COOKIE, identityEmail } from "@/lib/auth";

export async function memberFromBearer(req: NextRequest) {
  const auth = req.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) return null;
  await connectDb();
  return Member.findOne({ ingestToken: token }).lean();
}

export async function memberForStatus(req: NextRequest) {
  // The trusted reverse proxy may supply identity. A direct browser uses its
  // existing httpOnly viewer cookie; CLI callers may use the Bearer token.
  const email = identityEmail((name) => req.headers.get(name));
  if (email) { await connectDb(); return Member.findOne({ email }).lean(); }
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  if (token) { await connectDb(); return Member.findOne({ ingestToken: token }).lean(); }
  return memberFromBearer(req);
}
