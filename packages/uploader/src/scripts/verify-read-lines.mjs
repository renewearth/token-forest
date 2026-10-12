// readLines: "\n" is the only line break. U+2028 / U+2029 stay inside the line.
// Run: node packages/uploader/src/scripts/verify-read-lines.mjs
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { readLines } from "../lib/read-lines.mjs";

let pass = 0, fail = 0;
function eq(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++; else { fail++; console.log(`FAIL: ${label} (got ${JSON.stringify(got)})`); }
}
const dir = mkdtempSync(path.join(os.tmpdir(), "tf-read-lines-"));
const collect = async (text) => {
  const file = path.join(dir, "f.jsonl");
  writeFileSync(file, text);
  const out = [];
  for await (const line of readLines(file)) out.push(line);
  return out;
};
const LS = String.fromCharCode(0x2028), PS = String.fromCharCode(0x2029);

try {
  eq("plain lines", await collect("a\nb\n"), ["a", "b"]);
  eq("no trailing newline", await collect("a\nb"), ["a", "b"]);
  eq("CRLF", await collect("a\r\nb\r\n"), ["a", "b"]);
  eq("empty lines kept", await collect("a\n\nb\n"), ["a", "", "b"]);
  eq("empty file", await collect(""), []);

  const withSeparators = JSON.stringify({ type: "assistant", text: `one${LS}two${PS}three` });
  const lines = await collect(`${withSeparators}\n{"type":"user"}\n`);
  eq("line separators do not split a line", lines.length, 2);
  eq("the line still parses", JSON.parse(lines[0]).text, `one${LS}two${PS}three`);

  // A line longer than one stream chunk, with a multi-byte character across it.
  const long = "가".repeat(100_000);
  eq("long multi-byte line survives chunking", await collect(`${long}\nx\n`), [long, "x"]);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(fail === 0 ? `ALL PASS (${pass})` : `FAILED ${fail}/${pass + fail}`);
process.exit(fail === 0 ? 0 : 1);
