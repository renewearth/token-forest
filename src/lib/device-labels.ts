// Map opaque machineIds to stable display labels "기기 1/2/3". "" → placeholder.
// Stable within a render by sorting the distinct non-empty ids.
export function deviceLabels(machineIds: string[]): Map<string, string> {
  const distinct = [...new Set(machineIds.filter((m) => m !== ""))].sort();
  const map = new Map<string, string>();
  distinct.forEach((id, i) => map.set(id, `기기 ${i + 1}`));
  if (machineIds.includes("")) map.set("", "(기기명 없음)");
  return map;
}
