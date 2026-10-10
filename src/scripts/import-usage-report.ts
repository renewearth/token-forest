// No automatic .env loading; dry runs never connect to MongoDB.
import { readFile, stat } from "node:fs/promises";
import { parseClaudeSpendCsv } from "@/lib/report-import";
import { upsertUsageReports } from "@/lib/usage-reports";
import { closeDb } from "@/lib/db";

function arg(name: string) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0 || !process.argv[i + 1] || process.argv[i + 1].startsWith("--")) throw new Error(`--${name} 값이 필요합니다`);
  return process.argv[i + 1];
}
async function main() {
  const coverage = arg("coverage");
  if (!["full", "overage", "unknown"].includes(coverage)) throw new Error("coverage는 full, overage, unknown 중 하나입니다");
  const file = arg("file");
  if ((await stat(file)).size > 2_000_000) throw new Error("CSV는 2MB 이하여야 합니다");
  const rows = parseClaudeSpendCsv(await readFile(file, "utf8"), {
    accountId: arg("account"), periodStart: arg("from"), periodEnd: arg("to"), timeZone: arg("timezone"),
    coverage: coverage as "full" | "overage" | "unknown",
  });
  if (process.argv.includes("--write")) {
    await upsertUsageReports(rows);
    console.log(`보고서 ${rows.length}행 저장. 대시보드 토큰 합계에는 포함하지 않습니다.`);
  } else console.log(`검증 통과: ${rows.length}행. 저장하지 않았습니다 (--write로 저장). 기간 합계 유지, 토큰 합계 자동 반영 없음.`);
}
main().catch(error => { console.error(error instanceof Error ? error.message : "가져오기 실패"); process.exitCode = 1; }).finally(closeDb);
