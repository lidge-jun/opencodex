import { readBoundedResponseBody } from "../lib/bounded-body";
import type { WhamUsageResponse } from "./quota-types";

/** Fill only a missing Team balance. WHAM still owns all spend and quota flags. */
export async function withWorkspaceCreditBalance(
  usage: WhamUsageResponse,
  credential: { accessToken: string; chatgptAccountId: string },
  transport: typeof fetch,
  signal: AbortSignal,
): Promise<WhamUsageResponse> {
  const { accessToken, chatgptAccountId } = credential;
  const credits = usage.credits;
  if (usage.plan_type !== "team" || credits?.has_credits !== true || credits.unlimited === true
    || credits.overage_limit_reached === true || credits.balance != null
    || (usage.account_id != null && usage.account_id !== chatgptAccountId)
    || !/^[a-zA-Z0-9_-]+$/.test(chatgptAccountId) || signal.aborted) return usage;

  try {
    const response = await transport(`https://chatgpt.com/backend-api/accounts/${chatgptAccountId}/remaining_balance`, {
      headers: { Authorization: `Bearer ${accessToken}`, "ChatGPT-Account-Id": chatgptAccountId },
      redirect: "error",
      signal,
    });
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      return usage;
    }
    const body = await readBoundedResponseBody(response, { maxBytes: 64 * 1024, signal });
    if (!body.displaySafe || body.truncated || signal.aborted) return usage;
    const balance: unknown = JSON.parse(body.text)?.balance;
    if (typeof balance !== "string" || !/^\d+(\.\d+)?$/.test(balance) || !Number.isFinite(Number(balance))) return usage;
    return { ...usage, credits: { ...credits, balance } };
  } catch {
    // This optional billing read cannot invalidate successful WHAM quota or change auth state.
    return usage;
  }
}
