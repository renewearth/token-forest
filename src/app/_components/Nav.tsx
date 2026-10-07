"use client";

import { UsageLink } from "./UsageLink";
import { usePathname } from "next/navigation";

const NAV = [
  { href: "/", label: "대시보드" },
  { href: "/guide", label: "도감" },
  { href: "/team", label: "팀 분석" },
  { href: "/me", label: "내 사용량" },
  { href: "/knowhow", label: "노하우" },
  { href: "/members", label: "구성원" },
  { href: "/manual", label: "수동 입력" },
  { href: "/pricing", label: "단가표" },
  { href: "/setup", label: "설치 안내" },
  { href: "/collection", label: "수집 상태" },
];

function isActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

export default function Nav() {
  const pathname = usePathname();
  return (
    <nav className="flex min-w-0 flex-wrap gap-1 text-sm">
      {NAV.map((item) => {
        const active = isActive(pathname, item.href);
        return (
          <UsageLink
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={
              active
                ? "rounded-md bg-[var(--accent)]/15 px-3 py-1.5 font-medium text-[var(--accent-strong)] ring-1 ring-inset ring-[var(--accent)]/30"
                : "rounded-md px-3 py-1.5 text-[var(--text-secondary)] transition-colors hover:bg-black/5 hover:text-[var(--text-primary)] dark:hover:bg-white/5"
            }
          >
            {item.label}
          </UsageLink>
        );
      })}
    </nav>
  );
}
