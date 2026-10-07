"use client";

import { useActionState, useState } from "react";
import { registerPriceAction, type PriceFormState } from "./actions";

const inputCls =
  "w-full rounded-md border border-black/15 bg-transparent px-3 py-2 text-sm outline-none focus:border-[var(--series-1)] dark:border-white/15";
const labelCls = "mb-1 block text-xs font-medium text-[var(--text-secondary)]";

type FamilyInfo = { family: string; provider: string; match: string[] };

function FieldError({ msg }: { msg?: string }) {
  if (!msg) return null;
  return <p className="mt-1 text-xs text-[var(--series-6)]">{msg}</p>;
}

// families: latest entry per (family, provider). Typing an existing family
// switches the form to "new version" mode: patterns and scope are inherited
// server-side, so their inputs are locked (disabled inputs aren't submitted).
export default function PriceForm({
  families,
  defaultDate,
  minDate,
}: {
  families: FamilyInfo[];
  defaultDate: string; // KST today, from the server
  minDate: string; // earliest effectiveFrom the server accepts (today − 90 days)
}) {
  const [state, action, pending] = useActionState<PriceFormState, FormData>(
    registerPriceAction,
    {},
  );
  const e = state.errors ?? {};
  const [family, setFamily] = useState("");
  const scopes = families.filter((f) => f.family === family.trim());
  const existing = scopes.length > 0;
  const [scopePick, setScopePick] = useState("");
  const scope =
    scopes.find((f) => f.provider === scopePick) ??
    scopes.find((f) => f.provider === "") ??
    scopes[0];
  const names = [...new Set(families.map((f) => f.family))];

  return (
    <form action={action} className="space-y-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div>
          <label className={labelCls}>계열 (family)</label>
          <input
            name="family"
            required
            list="price-families"
            placeholder="예: grok"
            value={family}
            onChange={(ev) => {
              setFamily(ev.target.value);
              setScopePick("");
            }}
            className={inputCls}
          />
          <datalist id="price-families">
            {names.map((f) => (
              <option key={f} value={f} />
            ))}
          </datalist>
          <p className="mt-1 text-xs text-[var(--text-muted)]">
            {existing ? "기존 계열 — 새 적용일 단가만 추가합니다" : "새 계열"}
          </p>
          <FieldError msg={e.family} />
        </div>
        <div>
          <label className={labelCls}>
            {existing ? "모델명 패턴 (기존 계열 그대로)" : "모델명 패턴 (쉼표 구분, 3자 이상 또는 =정확한이름)"}
          </label>
          {existing ? (
            <input
              disabled
              value={(scope?.match.length ? scope.match : [family.trim()]).join(", ")}
              className={`${inputCls} opacity-60`}
            />
          ) : (
            <input name="match" placeholder="예: grok-4, =kimi-k2 (비우면 계열 이름)" className={inputCls} />
          )}
          <FieldError msg={e.match} />
        </div>
        <div>
          <label className={labelCls}>공급자·도구 한정 (비우면 전체)</label>
          {existing ? (
            scopes.length > 1 ? (
              <select
                name="provider"
                value={scope?.provider ?? ""}
                onChange={(ev) => setScopePick(ev.target.value)}
                className={inputCls}
              >
                {scopes.map((f) => (
                  <option key={f.provider} value={f.provider}>
                    {f.provider || "전체"}
                  </option>
                ))}
              </select>
            ) : (
              <>
                <input disabled value={scope?.provider || "전체"} className={`${inputCls} opacity-60`} />
                <input type="hidden" name="provider" value={scope?.provider ?? ""} />
              </>
            )
          ) : (
            <input name="provider" placeholder="예: codex" className={inputCls} />
          )}
          <FieldError msg={e.provider} />
        </div>
        <div>
          <label className={labelCls}>적용 시작일</label>
          <input type="date" name="effectiveFrom" required min={minDate} defaultValue={defaultDate} className={inputCls} />
          <FieldError msg={e.effectiveFrom} />
        </div>
        <div className="sm:col-span-2">
          <label className={labelCls}>출처 URL (필수, https://)</label>
          <input
            type="url"
            name="sourceUrl"
            required
            pattern="https://.+"
            placeholder="https://… 공식 단가 페이지"
            className={inputCls}
          />
          <FieldError msg={e.sourceUrl} />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        {(
          [
            ["input", "입력"],
            ["output", "출력"],
            ["cacheRead", "캐시 읽기"],
            ["cacheWrite", "캐시 쓰기"],
          ] as const
        ).map(([name, label]) => (
          <div key={name}>
            <label className={labelCls}>{label} (USD / 1M 토큰)</label>
            <input
              name={name}
              required
              inputMode="decimal"
              placeholder="0"
              className={`${inputCls} tabular-nums`}
            />
            <FieldError msg={e[name]} />
          </div>
        ))}
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div>
          <label className={labelCls}>출처 확인일</label>
          <input type="date" name="checkedAt" defaultValue={defaultDate} className={inputCls} />
          <FieldError msg={e.checkedAt} />
        </div>
        <div className="sm:col-span-2">
          <label className={labelCls}>메모</label>
          <input name="note" placeholder="예: 캐시 쓰기 단가 미공개 → 0" className={inputCls} />
          <FieldError msg={e.note} />
        </div>
      </div>
      <p className="text-xs text-[var(--text-muted)]">
        단가 변경은 기존 행을 고치지 않고 새 적용 시작일로 한 줄 더 등록합니다 — 과거 사용량은 그때의
        단가로 계산됩니다. 새 계열 패턴: <code>abc</code>=부분 일치(3자 이상), <code>=abc</code>=정확히
        일치 — 더 긴 패턴이 먼저 매칭됩니다. 추정값은 등록하지 마세요 — 공개 단가가 없으면 미정으로
        둡니다.
      </p>
      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-[var(--series-1)] px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {pending ? "저장 중…" : "단가 등록"}
        </button>
        {state.ok && state.message && (
          <span className="text-sm text-[var(--series-4)]">{state.message}</span>
        )}
        {state.ok === false && (state.message || e.form) && (
          <span className="text-sm text-[var(--series-6)]">{state.message ?? e.form}</span>
        )}
      </div>
    </form>
  );
}
