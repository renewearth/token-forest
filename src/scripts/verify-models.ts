// Pure assertions for the model catalog / normalization. No DB.
// Run: pnpm verify-models  (tsx src/scripts/verify-models.ts)
import {
  CATALOG_TOOLS,
  MODEL_CATALOG,
  canonicalizeModel,
  modelsForTool,
} from "@/lib/models";

let failed = 0;
function eq(actual: unknown, expected: unknown, label: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    failed++;
    console.error(`FAIL ${label}: got ${a}, want ${e}`);
  } else {
    console.log(`ok   ${label}`);
  }
}

// --- canonicalizeModel: alias variants collapse onto the uploader ids -------
eq(canonicalizeModel("opus-5"), "claude-opus-5", "opus-5 alias");
eq(canonicalizeModel("sonnet-5"), "claude-sonnet-5", "sonnet-5 alias");
eq(canonicalizeModel("haiku-4-5"), "claude-haiku-4-5-20251001", "haiku-4-5 alias");
eq(canonicalizeModel("fable-5"), "claude-fable-5", "fable-5 alias");

// Case + surrounding whitespace tolerated.
eq(canonicalizeModel("  Opus-5 "), "claude-opus-5", "alias trims + lowercases");

// Already-canonical passes through unchanged.
eq(canonicalizeModel("claude-opus-5"), "claude-opus-5", "canonical unchanged");

// Unknown model is never dropped — passes through verbatim.
eq(canonicalizeModel("some-new-model-9"), "some-new-model-9", "unknown pass-through");

// Empty / nullish stays the "no breakdown" sentinel.
eq(canonicalizeModel(""), "", "empty stays empty");
eq(canonicalizeModel(null), "", "null -> empty");
eq(canonicalizeModel(undefined), "", "undefined -> empty");

// Every alias target must itself be a canonical model listed in the catalog,
// so normalization can never point at a label that isn't a real model.
const catalogSet = new Set<string>(Object.values(MODEL_CATALOG).flat());
for (const bare of ["opus-5", "sonnet-5", "haiku-4-5", "fable-5"]) {
  const target = canonicalizeModel(bare);
  eq(catalogSet.has(target), true, `alias target in catalog: ${bare} -> ${target}`);
}

// --- catalog / dropdown wiring ----------------------------------------------
eq(CATALOG_TOOLS.includes("claude_code"), true, "claude_code is a catalog tool");
eq(modelsForTool("claude_code").includes("claude-opus-5"), true, "claude_code lists opus-5");
eq(modelsForTool("nonexistent-tool"), [], "unknown tool -> no models");

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log("\nall model assertions passed");
