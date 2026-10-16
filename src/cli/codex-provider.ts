import { allowCodexProviderRouting, approvedCodexProviders, previewCodexProviderConsent, restoreApprovedCodexProviders } from "../codex/provider-routing";
import { interactiveConfirm } from "./interactive-confirm";
import { terminalSafeError, terminalSafeText } from "./runtime-api";

export const CODEX_PROVIDER_USAGE = "Usage: ocx codex-provider <status|allow <id> [--yes]|revoke <id>>";

export async function handleCodexProviderCommand(args: string[]): Promise<number> {
  const [verb, id, flag] = args;
  if (verb === "status" && args.length === 1) {
    console.log(JSON.stringify({ approvedProviders: approvedCodexProviders() }));
    return 0;
  }
  if ((verb !== "allow" && verb !== "revoke") || !id || args.length > 3
    || (flag !== undefined && (verb !== "allow" || flag !== "--yes"))) {
    console.error(CODEX_PROVIDER_USAGE);
    return 1;
  }
  try {
    if (verb === "revoke") {
      restoreApprovedCodexProviders(id);
      console.log(`Routing consent revoked for ${terminalSafeText(id)}; any unchanged managed URL was restored.`);
      return 0;
    }
    const expected = previewCodexProviderConsent(id);
    console.log(`OpenCodex will manage only base_url for Codex provider ${terminalSafeText(id)} in the selected CODEX_HOME.`);
    console.log("Start/sync will route it to the local proxy; stop/restore will restore its original URL. Provider identity, transport settings and history stay unchanged.");
    if (flag !== "--yes") {
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        console.error("Explicit consent required: use an interactive terminal or pass --yes with the exact provider ID.");
        return 1;
      }
      if (!await interactiveConfirm({ question: "Allow this provider's routing to be managed?", defaultYes: false })) {
        console.log("Cancelled; no consent or routing changes were saved.");
        return 0;
      }
    }
    allowCodexProviderRouting(id, expected);
    console.log("Consent saved. Run ocx start or ocx sync to apply routing; use ocx codex-provider revoke <id> to undo consent.");
    return 0;
  } catch (error) {
    console.error(terminalSafeError(error));
    return 1;
  }
}
