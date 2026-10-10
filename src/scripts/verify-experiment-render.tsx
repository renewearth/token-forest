import React from "react";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import ExperimentContent from "@/app/knowhow/experiments/ExperimentContent";
import { emptyExperiment } from "@/lib/experiments";
import { clientRequestId } from "@/lib/client-request-id";
Object.assign(globalThis, { React });
const measurement = { kind: "estimate" as const, taskUnit: "문서 1건", unit: "분", aggregation: "per-task" as const, before: 10, after: 5, comparable: true, qualityMet: "no" as const };
const render = (m: typeof measurement) => renderToStaticMarkup(<ExperimentContent input={{ ...emptyExperiment, measurement: m }} />);
assert.ok(render(measurement).includes("차이 (후 − 전)"));
assert.ok(render(measurement).includes("품질 기준 미충족"));
assert.ok(!render({ ...measurement, comparable: false }).includes("차이 (후 − 전)"));
assert.ok(!render({ ...measurement, unit: "" }).includes("차이 (후 − 전)"));
assert.ok(!render({ ...measurement, before: 0 }).includes("Infinity"));
const html = renderToStaticMarkup(<ExperimentContent input={{ ...emptyExperiment, problem: '<script>alert("x")</script>' }} />);
assert.ok(!html.includes("<script>"));
const original = Object.getOwnPropertyDescriptor(globalThis, "crypto");
try {
  Object.defineProperty(globalThis, "crypto", { configurable: true, value: { getRandomValues: (v: Uint8Array) => v.fill(255) } });
  assert.equal(clientRequestId(), "ffffffff-ffff-4fff-bfff-ffffffffffff");
} finally { if (original) Object.defineProperty(globalThis, "crypto", original); }
console.log("Experiment rendering and private HTTP request ID: 7 PASS, 0 FAIL");
