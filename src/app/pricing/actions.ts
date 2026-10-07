"use server";

import { revalidatePath } from "next/cache";
import { requireMember } from "@/lib/auth";
import { deletePrice, registerPrice, type RegisterResult } from "@/lib/price-table";

// Initial form state is {} (nothing submitted yet).
export type PriceFormState = Partial<RegisterResult>;

const FIELDS = [
  "family",
  "match",
  "provider",
  "effectiveFrom",
  "input",
  "output",
  "cacheRead",
  "cacheWrite",
  "sourceUrl",
  "checkedAt",
  "note",
] as const;

// Any member may register a price (same audience as /manual). The registrant
// is the signed-in viewer — never a form field. Validation (https sourceUrl
// required, numbers, dates) lives in registerPrice's zod schema.
export async function registerPriceAction(
  _prev: PriceFormState,
  formData: FormData,
): Promise<PriceFormState> {
  let email: string;
  try {
    email = (await requireMember()).email;
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : "로그인이 필요합니다" };
  }
  const input: Record<string, string | undefined> = {};
  for (const f of FIELDS) {
    const v = formData.get(f);
    input[f] = typeof v === "string" ? v : undefined;
  }
  const result = await registerPrice(input, email);
  if (result.ok) {
    revalidatePath("/pricing");
    revalidatePath("/team");
  }
  return result;
}

export type DeletePriceState = Partial<RegisterResult>;

// Deletes one price version the signed-in viewer registered. Ownership and
// the seed guard are enforced in deletePrice (the button is only a hint).
export async function deletePriceAction(
  _prev: DeletePriceState,
  formData: FormData,
): Promise<DeletePriceState> {
  let email: string;
  try {
    email = (await requireMember()).email;
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : "로그인이 필요합니다" };
  }
  const get = (k: string) => {
    const v = formData.get(k);
    return typeof v === "string" ? v : "";
  };
  const result = await deletePrice(
    { provider: get("provider"), family: get("family"), effectiveFrom: get("effectiveFrom") },
    email,
  );
  if (result.ok) {
    revalidatePath("/pricing");
    revalidatePath("/team");
  }
  return result;
}
