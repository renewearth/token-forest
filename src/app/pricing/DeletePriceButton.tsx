"use client";

import { useActionState } from "react";
import { deletePriceAction, type DeletePriceState } from "./actions";

// Shown only on rows the viewer registered; the server re-checks ownership.
export default function DeletePriceButton({
  provider,
  family,
  effectiveFrom,
}: {
  provider: string;
  family: string;
  effectiveFrom: string;
}) {
  const [state, action, pending] = useActionState<DeletePriceState, FormData>(
    deletePriceAction,
    {},
  );
  return (
    <form
      action={action}
      onSubmit={(e) => {
        if (!confirm(`${family} · ${effectiveFrom} 단가를 삭제할까요?`)) e.preventDefault();
      }}
      className="mt-1"
    >
      <input type="hidden" name="provider" value={provider} />
      <input type="hidden" name="family" value={family} />
      <input type="hidden" name="effectiveFrom" value={effectiveFrom} />
      <button
        type="submit"
        disabled={pending}
        className="rounded border border-black/15 px-2 py-0.5 text-xs text-[var(--series-6)] hover:bg-black/5 disabled:opacity-50 dark:border-white/15 dark:hover:bg-white/5"
      >
        {pending ? "삭제 중…" : "삭제"}
      </button>
      {state.ok === false && state.message ? (
        <p className="mt-1 text-xs text-[var(--series-6)]">{state.message}</p>
      ) : null}
    </form>
  );
}
