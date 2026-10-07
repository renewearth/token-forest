import "./env";
import mongoose from "mongoose";
import { SEED_PRICES, priceFor } from "@/lib/pricing";
import { loadPriceTable } from "@/lib/price-table";
import { closeDb, connectDb, ModelPrice as ModelPriceModel } from "@/lib/db";

// Upgrade path for an already-seeded DB (R13): seeding runs once per process,
// so this lives in its own script — its first loadPriceTable() must meet a
// collection that already holds an OLDER seed.

let failed = 0;
function check(cond: boolean, msg: string) {
  if (cond) console.log("ok:", msg);
  else {
    failed++;
    console.error("FAIL:", msg);
  }
}

const VERSION_FAMILIES = ["opus-5.5", "sonnet-5", "fable-5.1"];

async function main() {
  const uri = process.env.MONGODB_URI ?? "";
  const dbName = uri.replace(/[?#].*$/, "").split("/").pop() ?? "";
  if (!dbName.startsWith("tf-v2-test")) {
    console.error(`REFUSING: DB name "${dbName}" does not start with tf-v2-test`);
    process.exit(1);
  }
  await connectDb();
  if (!mongoose.connection.name.startsWith("tf-v2-test")) {
    console.error(`REFUSING: connected DB "${mongoose.connection.name}" does not start with tf-v2-test`);
    process.exit(1);
  }
  await ModelPriceModel.deleteMany({});

  // The round-1 seed: everything except the 3 version rows, with one family
  // price edited in the DB (as an operator might) and one user-registered row.
  const oldSeed = SEED_PRICES.filter((e) => !VERSION_FAMILIES.includes(e.family));
  await ModelPriceModel.insertMany(
    oldSeed.map((e) => (e.family === "opus" ? { ...e, input: 99, note: "edited in DB" } : e)),
  );
  await ModelPriceModel.create({
    ...SEED_PRICES.find((e) => e.family === "sonnet")!,
    effectiveFrom: "2026-10-01",
    input: 4,
    registeredBy: "t@example.com",
  });
  const before = await ModelPriceModel.countDocuments();
  check(before === oldSeed.length + 1, `pre-state: old seed (${oldSeed.length}) + 1 user row`);

  const [t1, t2] = await Promise.all([loadPriceTable(), loadPriceTable()]);
  const after = await ModelPriceModel.countDocuments();
  check(after === before + VERSION_FAMILIES.length, `missing seed rows inserted (${before} → ${after})`);
  check(t1.entries.length === after && t2.entries.length === after, "concurrent loads both see the upgraded table");
  for (const f of VERSION_FAMILIES) {
    check((await ModelPriceModel.countDocuments({ family: f })) === 1, `version row ${f} exists once`);
  }
  const opus55 = priceFor(t1, "claude-opus-5-5", "claude_code", "2026-09-30");
  check(opus55?.input === 4 && opus55?.output === 20, `claude-opus-5-5 prices at 4/20 (${JSON.stringify(opus55)})`);

  const opus = await ModelPriceModel.findOne({ family: "opus", provider: "", effectiveFrom: "2000-01-01" }).lean();
  check(opus?.input === 99 && opus?.note === "edited in DB", "edited seed row NOT overwritten");
  check(priceFor(t1, "claude-opus-4-8", "claude_code", "2026-09-30")?.input === 99, "edited opus price still in effect");
  const user = await ModelPriceModel.findOne({ family: "sonnet", effectiveFrom: "2026-10-01" }).lean();
  check(user?.input === 4 && user?.registeredBy === "t@example.com", "user-registered row untouched");

  // Still once per process: a row deleted after seeding is not re-inserted
  // until the next process start.
  await ModelPriceModel.deleteOne({ family: "sonnet-5" });
  await loadPriceTable();
  check((await ModelPriceModel.countDocuments({ family: "sonnet-5" })) === 0, "seeding runs once per process");

  await ModelPriceModel.deleteMany({});
}

main()
  .then(async () => {
    await closeDb();
    if (failed) {
      console.error(`FAILED: ${failed}`);
      process.exit(1);
    }
    console.log("ALL PASS");
  })
  .catch(async (e) => {
    console.error(e);
    await closeDb();
    process.exit(1);
  });
