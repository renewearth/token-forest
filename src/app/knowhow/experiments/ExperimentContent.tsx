import { RESULTS, type ExperimentInput, type ReviewInput } from "@/lib/experiments";
const section = "whitespace-pre-wrap break-words text-sm";
export function SafeLinks({ links }: { links: string[] }) { return links.length ? <ul className="space-y-1 text-sm">{links.map((url, i) => <li key={i}><a href={url} target="_blank" rel="noopener noreferrer" className="break-all underline">참고 링크 {i + 1}: {url}</a></li>)}</ul> : null; }
export default function ExperimentContent({ input }: { input: ExperimentInput }) {
  const m = input.measurement;
  const comparable = m?.comparable && m.taskUnit && m.unit && m.aggregation && typeof m.before === "number" && typeof m.after === "number";
  const difference = comparable ? m!.after! - m!.before! : null;
  return <div className="min-w-0 space-y-3"><h2 className="break-words text-lg font-semibold">{input.title || "제목 없는 초안"}</h2>
    <div><h3 className="font-medium">업무 문제</h3><p className={section}>{input.problem || "미입력"}</p></div>
    <div><h3 className="font-medium">시도한 방법</h3><p className={section}>{input.method || "미입력"}</p></div>
    <p>결과: {input.result ? RESULTS[input.result] : "미선택"}</p><div><h3 className="font-medium">결과와 한계</h3><p className={section}>{input.limitations || "미입력"}</p></div>
    {input.tags.length > 0 && <p className="break-words text-sm">업무 태그: {input.tags.join(" · ")}</p>}{input.tools.length > 0 && <p className="break-words text-sm">도구·모델: {input.tools.join(" · ")}</p>}
    <SafeLinks links={input.links} />
    <section className="rounded border border-black/10 p-3 dark:border-white/10"><h3 className="font-medium">측정 근거</h3>
      <p className="text-sm">{m?.kind ? { estimate: "작성자 추정", direct: "직접 측정", reference: "참고 자료" }[m.kind] : "작성자 서술 · 수치 근거 미등록"}</p>
      {m && <dl className="space-y-1 break-words text-sm"><dt>측정 방법</dt><dd className="whitespace-pre-wrap">{m.method || "미등록"}</dd><dt>기간·표본</dt><dd>{m.start || "미등록"} ~ {m.end || "미등록"} · {m.sampleSize ?? "미등록"}개</dd><dt>업무 단위·집계 방식</dt><dd>{m.taskUnit || "미등록"} · {m.aggregation === "total" ? "전체" : m.aggregation === "per-task" ? "건당" : "미등록"}</dd><dt>전 / 후</dt><dd>{m.before ?? "—"} / {m.after ?? "—"} {m.unit || ""}</dd>{difference !== null && <><dt>차이 (후 − 전)</dt><dd>{difference > 0 ? "+" : ""}{Number(difference.toPrecision(12))} {m.unit} · 작성자가 확인한 동일 조건{difference < 0 && m.qualityMet === "no" ? " · 수치 감소, 품질 기준 미충족" : ""}</dd></>}<dt>검수·수정 시간 포함</dt><dd>{m.includesReview === "yes" ? "포함" : m.includesReview === "no" ? "미포함" : "미확인"}</dd><dt>품질 확인 방법</dt><dd className="whitespace-pre-wrap">{m.qualityMethod || "미등록"}</dd><dt>품질 기준 충족</dt><dd>{m.qualityMet === "yes" ? "충족" : m.qualityMet === "no" ? "미충족" : "미확인"}</dd><dt>비교 조건</dt><dd>{m.comparable ? "작성자가 동일 업무·단위·집계 방식을 확인함" : "동일 조건 미확인"} · 자동 개선율은 제공하지 않습니다.</dd></dl>}
    </section></div>;
}
export function ReviewContent({ input, currentVersion }: { input: ReviewInput; currentVersion?: number }) { return <div className="space-y-2"><p className="text-xs">적용 버전 {input.appliedVersion}{currentVersion && input.appliedVersion !== currentVersion ? " · 이전 내용에 대한 후기" : ""}</p><p className={section}>{input.conditions}</p><p>결과: {input.result ? RESULTS[input.result] : "미선택"}</p><p className={section}>{input.limitations}</p><SafeLinks links={input.links} /></div>; }
