import { getSignedInCodexIdentity } from "../signed-in-identity";
import type { OcxConfig } from "../../types";
import { captureConfigTopLevelRollback } from "../../config/rebase-provenance";
import { clearCodexAccountPin, pinnedCodexAccountId } from "../account-priority";
import { clearThreadAccountMapForAccount, previewCodexAccountForRequest } from "../routing";
import { forgetManualPreference } from "../routing/active-account";
import { withCodexAccountPauseGroup } from "./account-pause-group";
import { MAIN_CODEX_ACCOUNT_ID } from "../account-id";
import { getRuntimeConfig, saveRuntimeConfig } from "./runtime-config";
import { jsonResponse } from "./http";

/** Management owns the native-main claim; publish before releasing any runtime bindings. */
export async function handleCodexAccountPreservation(req: Request, config: OcxConfig): Promise<Response> {
  let update: { enabled: boolean; applyToBound: boolean } | undefined;
  if (req.method === "PUT") {
    const body: unknown = await req.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)
      || !("enabled" in body) || typeof body.enabled !== "boolean"
      || Object.keys(body).some(key => key !== "enabled" && key !== "applyToBound")
      || ("applyToBound" in body && typeof body.applyToBound !== "boolean")) {
      return jsonResponse({ error: "enabled and optional applyToBound must be booleans" }, 400);
    }
    const applyToBound = "applyToBound" in body && body.applyToBound === true;
    if (applyToBound && !body.enabled) return jsonResponse({ error: "applyToBound requires enabled: true" }, 400);
    update = { enabled: body.enabled, applyToBound };
  }
  const runtime = getRuntimeConfig(config);
  return withCodexAccountPauseGroup(runtime, MAIN_CODEX_ACCOUNT_ID, affectedAccountIds => {
    const releasedPin = update?.applyToBound === true && affectedAccountIds.includes(pinnedCodexAccountId(runtime) ?? "");
    if (update) {
      const rollback = captureConfigTopLevelRollback(runtime, ["codexPreserveSignedInAccount", "activeCodexAccountPinned"]);
      try {
        runtime.codexPreserveSignedInAccount = update.enabled;
        if (releasedPin) clearCodexAccountPin(runtime);
        saveRuntimeConfig(config, runtime);
      } catch (error) { rollback(); throw error; }
      if (update.applyToBound) {
        for (const id of affectedAccountIds) {
          clearThreadAccountMapForAccount(id);
          forgetManualPreference(id);
        }
      }
    }
    const enabled = runtime.codexPreserveSignedInAccount === true;
    const nextAccountId = previewCodexAccountForRequest(null, runtime);
    return jsonResponse({
      ok: true, enabled, affectedAccountIds, identityKnown: getSignedInCodexIdentity() !== undefined,
      nextAccountId,
      nextUsesSignedInQuota: nextAccountId !== null && affectedAccountIds.includes(nextAccountId),
      pinnedAccountId: pinnedCodexAccountId(runtime) ?? null,
      bindings: update?.applyToBound ? "released-for-next-request" : "retained",
      releasedPin,
      priorityFailbackEnabled: runtime.codexAccountPriorityFailback === true,
      fallbackConsumesSignedInQuota: true,
    });
  });
}
