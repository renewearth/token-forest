import { connectDb, Member, MemberIdentity, Device, VISIBLE_MEMBER } from "@/lib/db";

export type CollectionStatus = { id: string; name: string; lastReceivedAt: string | null; label: string };
// Only transport/parser health is public. Device names and raw errors stay private.
export async function getTeamCollectionStatus(): Promise<CollectionStatus[]> {
  await connectDb();
  const members = await Member.find(VISIBLE_MEMBER, { name: 1, email: 1 }).sort({ _id: 1 }).lean();
  const identities = await MemberIdentity.find({ memberId: { $in: members.map(m => m._id) } }, { memberId: 1, externalId: 1 }).lean();
  const ids = [...new Set([...members.map(m => m.email), ...identities.map(i => i.externalId)])];
  const devices = await Device.find({ externalId: { $in: ids } }, { externalId: 1, lastSeenAt: 1, health: 1 }).lean();
  const now = Date.now();
  return members.map(m => {
    const keys = new Set([m.email, ...identities.filter(i => String(i.memberId) === String(m._id)).map(i => i.externalId)]);
    const own = devices.filter(d => keys.has(d.externalId));
    const times = own.map(d => new Date(d.lastSeenAt).getTime()).filter(Number.isFinite);
    const last = times.length ? Math.max(...times) : null;
    const hasError = own.some(d => d.health?.some(h => h.error || h.linesUnrecognized >= 5));
    return { id: String(m._id), name: m.name, lastReceivedAt: last == null ? null : new Date(last).toISOString(),
      label: hasError ? "수집 오류 신호" : last == null ? "상태 미확인" : now - last > 86_400_000 ? "최근 수신 없음" : "최근 수신 확인 · 전체 수집 미확인" };
  });
}
