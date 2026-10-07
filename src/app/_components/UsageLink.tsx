"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, type ComponentProps } from "react";
import { usageHref } from "@/app/_lib/usage-url";

type Props = Omit<ComponentProps<typeof Link>, "href"> & { href: string };

function PreservedLink({ href, ...props }: Props) {
  const current = useSearchParams();
  return <Link href={usageHref(href, current)} {...props} />;
}

// Local boundary also lets static pages render a usable link during prerender.
export function UsageLink(props: Props) {
  return <Suspense fallback={<Link {...props} />}><PreservedLink {...props} /></Suspense>;
}
