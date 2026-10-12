// Read a log file line by line, splitting on "\n" only.
//
// node:readline also ends a line at U+2028 / U+2029. Those are legal inside a
// JSON string, so a transcript line that carries one (pasted text, a tool
// result) was cut into pieces that no longer parse — the line's usage was
// dropped and every piece counted as unrecognized.
import { createReadStream } from "node:fs";

export async function* readLines(file) {
  const stream = createReadStream(file, { encoding: "utf8" });
  let rest = "";
  try {
    for await (const chunk of stream) {
      const parts = (rest + chunk).split("\n");
      rest = parts.pop();
      for (const part of parts) yield part.endsWith("\r") ? part.slice(0, -1) : part;
    }
    if (rest) yield rest.endsWith("\r") ? rest.slice(0, -1) : rest;
  } finally {
    stream.destroy();
  }
}
