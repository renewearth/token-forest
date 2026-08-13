"use client";

import { useActionState, useState } from "react";
import {
  addUsageRow,
  commitCsv,
  previewCsv,
  type CsvState,
  type SingleState,
} from "./actions";
import type { Member } from "@/lib/queries";
import { CATALOG_TOOLS, modelsForTool } from "@/lib/models";

const CUSTOM = "__custom__";

const inputCls =
  "w-full rounded-md border border-black/15 bg-transparent px-3 py-2 text-sm outline-none focus:border-[var(--series-1)] dark:border-white/15";
const labelCls = "mb-1 block text-xs font-medium text-[var(--text-secondary)]";

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function FieldError({ msg }: { msg?: string }) {
  if (!msg) return null;
  return <p className="mt-1 text-xs text-[var(--series-6)]">{msg}</p>;
}

function SingleRowForm({ members, tools }: { members: Member[]; tools: string[] }) {
  const [state, action, pending] = useActionState<SingleState, FormData>(addUsageRow, {});

  // Tool dropdown = catalog tools first, then any extra tools already seen in
  // the DB, then a free-text escape hatch. Model options depend on the tool.
  const toolOptions = [...CATALOG_TOOLS, ...tools.filter((t) => !CATALOG_TOOLS.includes(t as never))];
  const [tool, setTool] = useState<string>(CATALOG_TOOLS[0]);
  const [model, setModel] = useState<string>("");
  const customTool = tool === CUSTOM;
  const [customToolName, setCustomToolName] = useState<string>("");
  const effectiveTool = customTool ? customToolName : tool;
  const modelOptions = modelsForTool(effectiveTool);
  const customModel = model === CUSTOM;

  return (
    <form action={action} className="space-y-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <label className={labelCls}>날짜</label>
          <input type="date" name="date" defaultValue={today()} required className={inputCls} />
          <FieldError msg={state.errors?.date} />
        </div>
        <div>
          <label className={labelCls}>구성원</label>
          <select name="memberId" required defaultValue="" className={inputCls}>
            <option value="" disabled>
              선택…
            </option>
            {members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name} ({m.email})
              </option>
            ))}
          </select>
          <FieldError msg={state.errors?.memberId} />
        </div>
        <div>
          <label className={labelCls}>도구</label>
          <select
            name={customTool ? undefined : "tool"}
            value={tool}
            onChange={(e) => {
              setTool(e.target.value);
              setModel(""); // model list is tool-specific — reset on tool change
            }}
            className={inputCls}
          >
            {toolOptions.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
            <option value={CUSTOM}>기타(직접 입력)…</option>
          </select>
          {customTool && (
            <input
              name="tool"
              value={customToolName}
              onChange={(e) => setCustomToolName(e.target.value)}
              placeholder="도구 이름 (예: opencode)"
              required
              className={`${inputCls} mt-2`}
            />
          )}
          <FieldError msg={state.errors?.tool} />
        </div>
        <div>
          <label className={labelCls}>모델 (선택)</label>
          <select
            name={customModel ? undefined : "model"}
            value={model}
            onChange={(e) => setModel(e.target.value)}
            className={inputCls}
          >
            <option value="">모델 없음 / 미지정</option>
            {modelOptions.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
            <option value={CUSTOM}>기타(직접 입력)…</option>
          </select>
          {customModel && (
            <input
              name="model"
              placeholder="정규 모델명 (예: claude-opus-5)"
              className={`${inputCls} mt-2`}
            />
          )}
        </div>
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div>
          <label className={labelCls}>입력 토큰</label>
          <input type="number" name="inputTokens" min="0" className={inputCls} />
          <FieldError msg={state.errors?.inputTokens} />
        </div>
        <div>
          <label className={labelCls}>출력 토큰</label>
          <input type="number" name="outputTokens" min="0" className={inputCls} />
        </div>
        <div>
          <label className={labelCls}>요청 수</label>
          <input type="number" name="requests" min="0" className={inputCls} />
        </div>
      </div>
      <p className="text-xs text-[var(--text-muted)]">
        토큰이 없는 도구(예: Copilot)는 요청 수만 입력하세요.
      </p>
      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-[var(--series-1)] px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {pending ? "저장 중…" : "기록 저장"}
        </button>
        {state.ok && state.message && (
          <span className="text-sm text-[var(--series-4)]">{state.message}</span>
        )}
        {state.ok === false && !state.errors && state.message && (
          <span className="text-sm text-[var(--series-6)]">{state.message}</span>
        )}
      </div>
    </form>
  );
}

function CsvForm() {
  const [csv, setCsv] = useState("");
  const [preview, previewAction, previewPending] = useActionState<CsvState, FormData>(
    previewCsv,
    {},
  );
  const [commit, commitAction, commitPending] = useActionState<CsvState, FormData>(
    commitCsv,
    {},
  );

  const rows = commit.rows ?? preview.rows;
  const errorCount = (commit.rows ? commit.errorCount : preview.errorCount) ?? 0;
  const validCount = (commit.rows ? commit.validCount : preview.validCount) ?? 0;

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) setCsv(await file.text());
  }

  return (
    <form action={previewAction} className="space-y-4">
      <div>
        <label className={labelCls}>
          CSV (columns: date,member_email,tool,model,input_tokens,output_tokens,requests)
        </label>
        <textarea
          name="csv"
          value={csv}
          onChange={(e) => setCsv(e.target.value)}
          rows={7}
          placeholder={
            "date,member_email,tool,model,input_tokens,output_tokens,requests\n2026-07-15,alice@example.com,cursor,,12000,3400,\n2026-07-15,bob@example.com,copilot,,,,45"
          }
          className={`${inputCls} font-mono`}
        />
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <input type="file" accept=".csv,text/csv" onChange={onFile} className="text-xs" />
        <button
          type="submit"
          disabled={previewPending || !csv.trim()}
          className="rounded-md border border-black/15 px-4 py-2 text-sm font-medium disabled:opacity-50 dark:border-white/15"
        >
          {previewPending ? "확인 중…" : "미리보기"}
        </button>
        <button
          type="submit"
          formAction={commitAction}
          disabled={commitPending || !csv.trim()}
          className="rounded-md bg-[var(--series-1)] px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {commitPending ? "가져오는 중…" : "가져오기"}
        </button>
      </div>

      {(preview.ok === false || commit.ok === false) && (
        <p className="text-sm text-[var(--series-6)]">{commit.message ?? preview.message}</p>
      )}
      {commit.committed && (
        <p className="text-sm text-[var(--series-4)]">{commit.message}</p>
      )}

      {rows && rows.length > 0 && (
        <div>
          <p className="mb-2 text-xs text-[var(--text-secondary)]">
            {commit.committed ? "저장 결과" : "미리보기"}: 전체 {rows.length}행 · 유효 {validCount} ·
            오류 {errorCount}
          </p>
          <div className="max-h-80 overflow-auto rounded-md border border-black/10 dark:border-white/10">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-[var(--surface-1)]">
                <tr className="text-left text-[var(--text-muted)]">
                  <th className="px-2 py-1.5">행</th>
                  <th className="px-2 py-1.5">날짜</th>
                  <th className="px-2 py-1.5">구성원</th>
                  <th className="px-2 py-1.5">도구</th>
                  <th className="px-2 py-1.5 text-right">입력</th>
                  <th className="px-2 py-1.5 text-right">출력</th>
                  <th className="px-2 py-1.5 text-right">요청</th>
                  <th className="px-2 py-1.5">상태</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr
                    key={r.line}
                    className="border-t border-black/5 dark:border-white/5"
                  >
                    <td className="px-2 py-1.5 tabular-nums text-[var(--text-muted)]">{r.line}</td>
                    <td className="px-2 py-1.5">{r.date}</td>
                    <td className="px-2 py-1.5">{r.memberEmail}</td>
                    <td className="px-2 py-1.5">{r.tool}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{r.inputTokens ?? "—"}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{r.outputTokens ?? "—"}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{r.requests ?? "—"}</td>
                    <td className="px-2 py-1.5">
                      {r.error ? (
                        <span className="text-[var(--series-6)]">{r.error}</span>
                      ) : (
                        <span className="text-[var(--series-4)]">
                          {commit.committed ? "저장됨" : "확인"}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </form>
  );
}

export default function ManualForms({
  members,
  tools,
}: {
  members: Member[];
  tools: string[];
}) {
  return (
    <div className="space-y-6">
      <section className="rounded-xl border border-black/10 bg-[var(--surface-1)] p-5 dark:border-white/10">
        <h2 className="mb-4 text-sm font-semibold">단일 행 입력</h2>
        <SingleRowForm members={members} tools={tools} />
      </section>
      <section className="rounded-xl border border-black/10 bg-[var(--surface-1)] p-5 dark:border-white/10">
        <h2 className="mb-1 text-sm font-semibold">CSV 가져오기</h2>
        <p className="mb-4 text-xs text-[var(--text-muted)]">
          미리보기로 각 행을 검증한 뒤 가져오기로 저장합니다. 오류 행은 저장에서 제외됩니다.
        </p>
        <CsvForm />
      </section>
    </div>
  );
}
