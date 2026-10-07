"use client";
export default function ErrorView({ reset }: { reset: () => void }) { return <section className="space-y-3 p-6"><p role="alert">기록을 불러오지 못했습니다.</p><button className="rounded border px-3 py-2" onClick={reset}>다시 시도</button></section>; }
