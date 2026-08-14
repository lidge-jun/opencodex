import type { TFn } from "../i18n/shared";
import { readJsonIfOk } from "../fetch-json";
import { createBoundedFetch } from "../bounded-fetch";

const RESET_CREDIT_OWNER_TOKEN_HEADER = "x-opencodex-reset-credit-owner-token";
const RESET_CREDIT_IDENTITY_CHANGED_CODE = "reset_credit_operation_identity_changed";
const RESET_CREDIT_OPERATION_HISTORY_FULL_CODE = "reset_credit_operation_history_full";
export const RESET_CREDIT_REQUEST_TIMEOUT_MS = 15_000;

export async function redeemResetCredit(
  apiBase: string,
  accountId: string,
  operationId: string,
  t: TFn,
  load: (refresh?: boolean) => Promise<boolean>,
  ownerToken: string,
): Promise<{
  ok: boolean;
  outcome: "terminal" | "ambiguous";
  toast?: string;
}> {
  const bounded = createBoundedFetch(RESET_CREDIT_REQUEST_TIMEOUT_MS);
  try {
    const resp = await fetch(`${apiBase}/api/codex-auth/reset-credits/consume`, {
      method: "POST",
      signal: bounded.signal,
      headers: {
        "Content-Type": "application/json",
        [RESET_CREDIT_OWNER_TOKEN_HEADER]: ownerToken,
      },
      body: JSON.stringify({ accountId, operationId }),
    });
    if (!resp.ok) {
      try {
        const rejected = await resp.json() as { code?: unknown };
        if (resp.status === 409 && rejected.code === RESET_CREDIT_IDENTITY_CHANGED_CODE) {
          return {
            ok: false,
            outcome: "terminal",
            toast: t("codexAuth.resetIdentityChanged"),
          };
        }
        if (resp.status === 507 && rejected.code === RESET_CREDIT_OPERATION_HISTORY_FULL_CODE) {
          return {
            ok: false,
            outcome: "terminal",
            toast: t("codexAuth.resetHistoryFull"),
          };
        }
      } catch { /* malformed rejections remain ambiguous */ }
      return { ok: false, outcome: "ambiguous", toast: t("codexAuth.resetError") };
    }
    const result = await readJsonIfOk<{ code: string }>(resp);
    if (!result) return { ok: false, outcome: "ambiguous", toast: t("codexAuth.resetError") };
    if (result.code === "reset" || result.code === "already_redeemed") {
      try { await load(true); } catch { /* the consume outcome is already terminal */ }
      return {
        ok: true,
        outcome: "terminal",
        toast: t(result.code === "already_redeemed"
          ? "codexAuth.resetAlreadyRedeemed"
          : "codexAuth.resetSuccessGeneric"),
      };
    }
    if (result.code === "nothing_to_reset" || result.code === "no_credit") {
      const key = result.code === "nothing_to_reset"
        ? "codexAuth.resetNothingToReset"
        : "codexAuth.resetNoCredit";
      return { ok: false, outcome: "terminal", toast: t(key) };
    }
    return { ok: false, outcome: "ambiguous", toast: t("codexAuth.resetError") };
  } catch {
    return { ok: false, outcome: "ambiguous", toast: t("codexAuth.resetError") };
  } finally {
    bounded.clear();
  }
}
