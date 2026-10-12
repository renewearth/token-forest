import { getGrowthDays, getUnconfirmedGrowthDates } from "../lib/queries";
import { computeGrowth } from "../lib/growth";
import { teamEpoch, todayKst } from "../lib/date";
import { Member, connectDb } from "../lib/db";

async function main() {
  const email = process.argv[2];
  if (!email) { console.error("usage: verify-growth-days.ts <member email>"); process.exit(1); }
  await connectDb();
  const m = await Member.findOne({ email }).lean();
  if (!m) { console.error("no member"); process.exit(1); }
  const onboarded = m.onboardedAt ? new Date(m.onboardedAt).toISOString().slice(0, 10) : null;
  const days = await getGrowthDays(String(m._id), teamEpoch());
  const g = computeGrowth(days, teamEpoch(), todayKst(), undefined, await getUnconfirmedGrowthDates(todayKst()));
  console.log("onboardedAt:", onboarded, "activeDays:", g.activeDays);
  console.log("growth:", JSON.stringify(g, null, 2));
  process.exit(0);
}

main();
