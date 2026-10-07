const KEYS = ["basis", "unit", "ref", "days"] as const;

export function usageHref(href: string, current: Pick<URLSearchParams, "get">): string {
  if (!href.startsWith("/") || href.startsWith("//")) return href;
  const target = new URL(href, "https://token-forest.invalid");
  for (const key of KEYS) {
    const value = current.get(key);
    if (value !== null && !target.searchParams.has(key)) target.searchParams.set(key, value);
  }
  return `${target.pathname}${target.search}${target.hash}`;
}
