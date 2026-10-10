"use client";
import Link from "next/link";
export default function ErrorView({ reset }: { reset: () => void }) { return <section className="space-y-3 p-6"><p role="alert">노하우를 불러오지 못했습니다.</p><button className="rounded border px-3 py-2" onClick={reset}>다시 시도</button><Link href="/knowhow" className="ml-3 underline">첫 페이지</Link></section>; }
