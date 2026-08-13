import type { TFn } from "../i18n/shared";
import { readJsonIfOk } from "../fetch-json";

function remainingCreditsToast(
  t: TFn,
  remaining: number | undefined,
): string {
  if (remaining === undefined) return t("codexAuth.resetSuccessGeneric");
  return t("codexAuth.resetSuccess", { remaining: String(remaining) });
}

export async function redeemResetCredit(
  apiBase: string,
  accountId: string,
  operationId: string,
  t: TFn,
  load: (refresh?: boolean) => Promise<boolean>,
): Promise<{
  ok: boolean;
  outcome: "terminal" | "ambiguous";
  toast?: string;
}> {
  try {
    const resp = await fetch(`${apiBase}/api/codex-auth/reset-credits/consume`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accountId, operationId }),
    });
    const result = await readJsonIfOk<{ code: string; remaining?: number }>(resp);
    if (!result) return { ok: false, outcome: "ambiguous", toast: t("codexAuth.resetError") };
    if (result.code === "reset" || result.code === "already_redeemed") {
      try { await load(true); } catch { /* the consume outcome is already terminal */ }
      // Authoritative remaining comes from the management endpoint (refreshed quota).
      // Never invent a decrement from a stale modal snapshot.
      const remaining =
        typeof result.remaining === "number" && Number.isFinite(result.remaining)
          ? Math.max(0, result.remaining)
          : undefined;
      return {
        ok: true,
        outcome: "terminal",
        toast: remainingCreditsToast(t, remaining),
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
  }
}
