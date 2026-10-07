import type { Unit } from "@/lib/units";
import { formatCompact, formatNumber, type NumStyle } from "./ui";

// Dollar conversions often fall below one cent. Keep those values visible.
export function formatUsage(value: number | null | undefined, unit: Unit, numStyle?: NumStyle): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  if (unit === "usd") {
    if (value > 0 && value < 0.000001) return "<$0.000001";
    return `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 })}`;
  }
  return numStyle ? formatCompact(value, numStyle) : formatNumber(value);
}
