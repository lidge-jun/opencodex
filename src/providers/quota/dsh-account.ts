import { DSH_PLATFORM_ORIGIN } from "../../oauth/dsh";
import { asRecord, QUOTA_JSON_READ_FAILURE, readQuotaJson, REQUEST_TIMEOUT_MS } from "../quota-wire";
import { AUTHORITATIVE_EMPTY_QUOTA, TERMINAL_QUOTA_FAILURE, type ProviderQuotaProbeResult } from "./report-cache";

export async function fetchDshAccountQuota(
  _provider: string,
  accessToken: string,
): Promise<ProviderQuotaProbeResult> {
  if (!accessToken || !accessToken.trim()) return null;

  try {
    const response = await fetch(`${DSH_PLATFORM_ORIGIN}/api/v0/users/get_user_summary`, {
      method: "GET",
      headers: {
        "x-dsh-auth-token": accessToken.trim(),
        "Accept": "application/json",
      },
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (response.status === 401) {
      return TERMINAL_QUOTA_FAILURE;
    }
    if (!response.ok) {
      return null;
    }

    const bodyRaw = await readQuotaJson(response);
    if (bodyRaw === QUOTA_JSON_READ_FAILURE) {
      return null;
    }

    const body = asRecord(bodyRaw);
    if (!body || body.code !== 0) {
      return null;
    }

    const data = asRecord(body.data);
    const bizData = asRecord(data?.biz_data);
    const summary = asRecord(bizData?.user_summary) ?? bizData;
    if (!summary) return null;

    // DeepSeek platform reports monetary wallet amounts (normal_wallets, bonus_wallets, total_costs)
    // without capacity or percentage-based rate-limit windows.
    // Fabricating a synthetic percent: 0 custom window would falsely mark an empty wallet (¥0.00)
    // as "0% used" (healthy quota) and pollute quota exhaustion / account ranking.
    // Instead, return AUTHORITATIVE_EMPTY_QUOTA to confirm the credential is active while leaving
    // quota routing evidence unknown.
    return AUTHORITATIVE_EMPTY_QUOTA;
  } catch {
    return null;
  }
}
