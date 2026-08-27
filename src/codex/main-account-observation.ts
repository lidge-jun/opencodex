import { extractAccountId, extractEmail } from "../oauth/chatgpt";
import { readBoundedResponseBody } from "../lib/bounded-body";
import { captureConfigGeneration } from "../lib/state-store-sweeper";
import { codexPlanValue, extractChatgptPlanType } from "./plan";
import { clearAccountNeedsReauth } from "./account-runtime-state";
import {
  clearAccountQuota,
  parseUsageQuota,
  setAccountQuotaFromParsed,
  type WhamUsageResponse,
} from "./quota";
import { MAIN_CODEX_ACCOUNT_ID, setMainAccountPlan } from "./main-account";
import {
  captureMainAccountIdentityGeneration,
  getMainAccountInfoCache,
  isMainAccountIdentityGenerationLive,
  setCodexManagedMainAccountObservation,
} from "./main-account-cache";

const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const MANAGED_USAGE_SUCCESS_TTL_MS = 5 * 60_000;
const MANAGED_USAGE_FAILURE_TTL_MS = 15_000;
const MANAGED_USAGE_TIMEOUT_MS = 8_000;
const MANAGED_USAGE_MAX_BYTES = 256 * 1024;

interface CodexManagedRequestCredential {
  accessToken: string;
  accountId: string | null;
  email: string | null;
  plan: string | null;
}

interface CodexManagedUsageOptions {
  fetcher?: typeof fetch;
  now?: number;
}

let managedUsageFlight: { generation: number; promise: Promise<boolean> } | null = null;
let managedUsageNextProbe: { generation: number; at: number } | null = null;

function codexManagedRequestCredential(headers: Headers): CodexManagedRequestCredential | null {
  const match = /^Bearer\s+(\S+)$/i.exec(headers.get("authorization")?.trim() ?? "");
  if (!match) return null;
  const accessToken = match[1]!;
  return {
    accessToken,
    accountId: headers.get("chatgpt-account-id")?.trim()
      || extractAccountId(undefined, accessToken)
      || null,
    email: extractEmail(undefined, accessToken) ?? null,
    plan: extractChatgptPlanType(undefined, accessToken) ?? null,
  };
}

function commitCodexManagedMainIdentity(credential: CodexManagedRequestCredential): number {
  const identityChanged = setCodexManagedMainAccountObservation({
    accountId: credential.accountId,
    email: credential.email,
    plan: credential.plan,
  });
  if (identityChanged) clearAccountQuota(MAIN_CODEX_ACCOUNT_ID);
  clearAccountNeedsReauth(MAIN_CODEX_ACCOUNT_ID);
  setMainAccountPlan(getMainAccountInfoCache()?.plan ?? null);
  return captureMainAccountIdentityGeneration();
}

/**
 * Learn non-secret main-account metadata from a successful native Codex request.
 *
 * Codex keeps modern ChatGPT credentials in the OS keyring and attaches the current bearer to
 * each request. OpenCodex must use that bearer only for the request that carried it; this observer
 * retains email/plan/account identity decoded from the JWT, never the bearer itself.
 */
export function observeSuccessfulCodexManagedMainRequest(headers: Headers): boolean {
  const credential = codexManagedRequestCredential(headers);
  if (!credential) return false;
  commitCodexManagedMainIdentity(credential);
  return true;
}

/**
 * Learn the WHAM-only quota fields (notably reset-credit count) while Codex's keyring bearer is
 * already present on a successful native request. The bearer lives only in this bounded probe and
 * is never copied into config, the account store, the main-account cache, or a management DTO.
 */
export function observeSuccessfulCodexManagedMainUsage(
  headers: Headers,
  options: CodexManagedUsageOptions = {},
): Promise<boolean> {
  const credential = codexManagedRequestCredential(headers);
  if (!credential) return Promise.resolve(false);
  const generation = commitCodexManagedMainIdentity(credential);
  // A stable ChatGPT account id is required to reject a late WHAM response after the native
  // keyring login switches accounts. A plan-bearing JWT without that identity can still populate
  // the plan badge through the synchronous observation above, but cannot authorize quota commit.
  if (!credential.accountId) return Promise.resolve(false);

  const now = options.now ?? Date.now();
  if (managedUsageNextProbe?.generation === generation && managedUsageNextProbe.at > now) {
    return Promise.resolve(false);
  }
  if (managedUsageFlight?.generation === generation) return managedUsageFlight.promise;

  const writerGeneration = captureConfigGeneration();
  const fetcher = options.fetcher ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new DOMException("Codex managed usage probe timed out", "TimeoutError"));
  }, MANAGED_USAGE_TIMEOUT_MS);
  const promise = (async (): Promise<boolean> => {
    try {
      const response = await fetcher(CODEX_USAGE_URL, {
        headers: {
          Authorization: `Bearer ${credential.accessToken}`,
          "ChatGPT-Account-Id": credential.accountId!,
          Accept: "application/json",
        },
        redirect: "error",
        signal: controller.signal,
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        return false;
      }
      const body = await readBoundedResponseBody(response, {
        signal: controller.signal,
        maxBytes: MANAGED_USAGE_MAX_BYTES,
        fatalUtf8: true,
      });
      if (!body.displaySafe || body.truncated) return false;
      const parsed: unknown = JSON.parse(body.text);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
      if (!isMainAccountIdentityGenerationLive(generation)) return false;

      const data = parsed as WhamUsageResponse;
      const whamPlan = codexPlanValue(data.plan_type);
      if (whamPlan) {
        setCodexManagedMainAccountObservation({
          accountId: credential.accountId,
          email: credential.email,
          plan: whamPlan,
        });
        setMainAccountPlan(whamPlan);
      }
      const quota = parseUsageQuota(data);
      if (quota) setAccountQuotaFromParsed(MAIN_CODEX_ACCOUNT_ID, quota, writerGeneration);
      return true;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  })();

  managedUsageFlight = { generation, promise };
  void promise.then(success => {
    if (managedUsageFlight?.promise === promise) managedUsageFlight = null;
    managedUsageNextProbe = {
      generation,
      at: (options.now ?? Date.now())
        + (success ? MANAGED_USAGE_SUCCESS_TTL_MS : MANAGED_USAGE_FAILURE_TTL_MS),
    };
  });
  return promise;
}
