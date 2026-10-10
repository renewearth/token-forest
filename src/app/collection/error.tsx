"use client";
export default function ErrorPage({ reset }: { reset: () => void }) {
  return <div role="alert" className="space-y-3 py-8"><p>보고서를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.</p><button type="button" onClick={reset} className="rounded border px-4 py-2">다시 시도</button></div>;
}
