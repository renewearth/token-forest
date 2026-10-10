import Link from "next/link";
import { STAGE_LEGEND, milestoneGroups, STATE_LEGEND } from "@/lib/forest-symbols";
import { PageHeader, Card } from "@/app/_components/ui";

export default function GuidePage() {
  return <div className="space-y-4">
    <PageHeader title="표시와 집계 안내" />
    <Card title="팀의 숲"><p>기존 성장형 숲을 보여줍니다. 나무 단계·레벨·연속 기록·장식은 게임 규칙에 따라 표시되며, 배경과 동물은 시간대에 따라 달라집니다. 이름을 누르면 구성원별 사용 흐름을 볼 수 있습니다.</p></Card>
    <Card title="숲의 기호"><div className="space-y-3 text-sm">
      <div><h3 className="mb-1 font-medium">나무 단계</h3><div className="flex flex-wrap gap-2">{STAGE_LEGEND.map(s => <span key={s.label}>{s.emoji} {s.label}{s.threshold !== undefined ? ` · ${s.threshold} GP 이상` : " · 기록 전"}</span>)}</div></div>
      {milestoneGroups().map(g => <div key={g.axis}><h3 className="mb-1 font-medium">{g.axisLabel} — {g.meaning}</h3><div className="flex flex-wrap gap-2">{g.tiers.map(t => <span key={t.emoji}>{t.emoji} {t.label}</span>)}</div></div>)}
      <div><h3 className="mb-1 font-medium">상태</h3>{STATE_LEGEND.map(s => <p key={s.emoji}>{s.emoji} {s.label} — {s.meaning}</p>)}</div>
      <p>게임 표시는 업무 성과나 숙련도 평가가 아닙니다. 수집되지 않은 기록은 게임에도 반영되지 않을 수 있습니다.</p>
    </div></Card>
    <Card title="수집된 사용량"><div className="space-y-2 text-sm">
      <p>전체 처리량은 일반 입력·캐시 읽기·캐시 쓰기·출력의 수집 합계입니다. 집계 기준과 단위는 합계·그래프·표에 함께 적용됩니다.</p>
      <p>요청 수는 소스가 제공한 건수입니다. 사람의 질문 횟수나 완료한 업무 수와 같지 않습니다.</p>
      <p>—는 확인할 수 없는 값입니다. 수집된 부분합이 있어도 기록되지 않은 도구·기기의 실제 사용을 알 수 없으므로 전체 실제 사용량이라고 단정하지 않습니다.</p>
      <p>USD는 공개 단가에 따른 추정값이며 청구 금액이나 구독료가 아닙니다. 기준 모델 토큰도 가격을 활용한 환산값입니다.</p>
      <p>구성원 선을 숨겨도 수집된 전체 합계선은 바뀌지 않습니다. 사용량의 증가·감소가 성과의 증가·감소를 뜻하지 않습니다.</p>
    </div></Card>
    <Card title="업무 실험과 적용 후기"><p className="text-sm">업무 문제·방법·결과와 한계를 선택해 기록합니다. 악화·판단 유보·중단도 공유할 수 있습니다. 초안은 본인만 읽고, 공개 대상을 확인한 뒤 직접 공유합니다. 동료의 후기는 실제 적용한 조건과 함께 읽어 주세요.</p></Card>
    <Card title="개인의 기존 게임 기록"><p className="text-sm">기존 성장 계산과 원본 기록은 유지됩니다. 본인의 <Link className="underline" href="/me">내 사용량</Link>에서 접힌 ‘기존 성장 보기’를 열 수 있습니다. 게임 보너스와 복구 규칙은 업무 성과를 평가하거나 필요한 AI 사용량을 정하는 기준이 아닙니다.</p></Card>
  </div>;
}
