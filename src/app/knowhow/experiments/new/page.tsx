export const dynamic = "force-dynamic";
import Link from "next/link";
import { getViewer } from "@/lib/auth";
import { enabledFor } from "@/lib/experiments";
import ExperimentEditor from "../ExperimentEditor";
export default async function NewExperimentPage() { const viewer = await getViewer(); return <main className="mx-auto flex w-full min-w-0 max-w-2xl flex-col gap-4 p-4 sm:p-6"><Link href="/knowhow?type=experiments" className="underline">업무 실험 목록</Link><h1 className="text-xl font-semibold">업무 실험 기록</h1>{viewer.status !== "member" ? <p>로그인 후 이용할 수 있습니다. <Link href="/me" className="underline">로그인</Link></p> : enabledFor(viewer.member.id) ? <ExperimentEditor /> : <p>현재 신규 작성을 이용할 수 없습니다. 기존 기록은 내 사용량에서 확인하세요.</p>}</main>; }
