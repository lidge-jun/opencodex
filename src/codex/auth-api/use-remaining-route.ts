import type { OcxConfig } from "../../types";
import { captureConfigTopLevelRollback } from "../../config/rebase-provenance";
import { MAIN_CODEX_ACCOUNT_ID, isValidCodexAccountId } from "../account-id";
import { getEffectiveCodexAutoSwitchThreshold } from "../account-auto-switch";
import { codexAccountUsesRemainingQuota, setCodexAccountUseRemainingQuota } from "../account-use-remaining";
import { getMainAccountHardLockStatus } from "../main-account-hard-lock";
import { configuredPoolAccount, getRuntimeConfig, saveRuntimeConfig } from "./runtime-config";
import { jsonResponse } from "./http";

/** Called only behind the existing Codex management authentication boundary. */
export async function handleUseRemainingQuotaRoute(req: Request, url: URL, config: OcxConfig): Promise<Response> {
  const parsed: unknown = req.method === "PUT" ? await req.json().catch(() => null) : { id: url.searchParams.get("id") };
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return jsonResponse({ error: "body must be an object" }, 400);
  const body = parsed as { id?: unknown; useRemainingQuota?: unknown };
  if (typeof body.id !== "string" || (body.id !== MAIN_CODEX_ACCOUNT_ID && !isValidCodexAccountId(body.id))) {
    return jsonResponse({ error: "Invalid account id format" }, 400);
  }
  const runtime = getRuntimeConfig(config);
  if (body.id !== MAIN_CODEX_ACCOUNT_ID && !configuredPoolAccount(runtime, body.id)) return jsonResponse({ error: "Account not found" }, 404);
  if (req.method === "PUT") {
    if (typeof body.useRemainingQuota !== "boolean") return jsonResponse({ error: "useRemainingQuota must be a boolean" }, 400);
    const rollback = captureConfigTopLevelRollback(runtime, ["codexUseRemainingQuotaAccountIds"]);
    try {
      setCodexAccountUseRemainingQuota(runtime, body.id, body.useRemainingQuota);
      saveRuntimeConfig(config, runtime);
    } catch (error) {
      rollback();
      throw error;
    }
  }
  return jsonResponse({ ok: true, id: body.id,
    useRemainingQuota: codexAccountUsesRemainingQuota(runtime, body.id),
    autoSwitchThreshold: getEffectiveCodexAutoSwitchThreshold(runtime, body.id),
    ...(body.id === MAIN_CODEX_ACCOUNT_ID ? { mainAccountHardLock: getMainAccountHardLockStatus(runtime) } : {}),
  });
}
