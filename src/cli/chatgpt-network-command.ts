import { runtimeRequest, runtimeBaseUrl, type RuntimeApiDeps } from "./runtime-api";
import { findLiveProxy } from "../server/proxy-liveness";
import { cloudHelperRequest } from "../chatgpt/cloud-network/helper-client";
import { CloudNetworkError } from "../chatgpt/cloud-network/contract";
import { interactiveConfirm } from "./interactive-confirm";

export const CHATGPT_NETWORK_USAGE = `Usage (macOS, built into OpenCodex):
  ocx chatgpt network status
  ocx chatgpt network install [--yes]    Authorize the internal recovery helper; routing stays off
  ocx chatgpt network enable            Save cloudNetwork=true and start the live integration
  ocx chatgpt network disable           Save cloudNetwork=false and restore the owned mapping
  ocx chatgpt network recover           Disable and retry mapping/cache recovery
  ocx chatgpt network uninstall [--yes]  Remove the idle internal helper after disable
Uses OpenCodex's configured outbound proxy and loopback 443. No CA, signed app or system extension.
Only codex-cloud-backend.chatgpt.com is mapped; this affects all OS-resolver clients of that host.
Enable requires an installed helper and a running OpenCodex server.`;

export function cloudNetworkArguments(args: string[]) {
  const action = args[0];
  if (!["status", "install", "enable", "disable", "recover", "uninstall"].includes(action ?? "")
    || args.length > 2 || (args.length === 2 && (!["install", "uninstall"].includes(action!) || args[1] !== "--yes"))) {
    throw new Error(CHATGPT_NETWORK_USAGE);
  }
  return { action: action as "status" | "install" | "enable" | "disable" | "recover" | "uninstall", yes: args[1] === "--yes" };
}

export async function handleChatgptNetworkCommand(args: string[], platform: NodeJS.Platform = process.platform, deps: RuntimeApiDeps = {}): Promise<number> {
  if (args.length === 0 || (args.length === 1 && ["help", "--help", "-h"].includes(args[0]!))) {
    console.log(CHATGPT_NETWORK_USAGE); return args.length ? 0 : 64;
  }
  let options: ReturnType<typeof cloudNetworkArguments>;
  try { options = cloudNetworkArguments(args); }
  catch { console.error(CHATGPT_NETWORK_USAGE); return 64; }
  if (platform !== "darwin") { console.error("Cloud network integration requires macOS."); return 1; }
  try {
    if (options.action === "install" || options.action === "uninstall") {
      if (options.action === "uninstall" && (await import("../config/diagnostics")).readConfigDiagnostics().config.chatgptDesktop?.cloudNetwork === true) {
        throw new Error("Disable cloud network before uninstalling its recovery helper.");
      }
      const { CLOUD_INSTALL_CONSENT, requestCloudHelperInstall } = await import("../chatgpt/cloud-network/install");
      console.log(options.action === "install" ? CLOUD_INSTALL_CONSENT : "Remove OpenCodex's idle cloud-network recovery helper with administrator permission. Disable the feature first.");
      if (!options.yes && (!process.stdin.isTTY || !await interactiveConfirm({ question: "Continue with administrator authorization?", defaultYes: false }))) return 1;
      const code = requestCloudHelperInstall(options.action);
      if (code === 0) console.log(options.action === "install" ? "Recovery helper installed; routing remains off until explicitly enabled." : "Cloud-network helper removed; owned mapping recovered.");
      return code;
    }
    const live = deps.baseUrl ? true : await (deps.findLiveProxy ?? findLiveProxy)();
    if (live) {
      const baseUrl = await runtimeBaseUrl({ ...deps, ...(live !== true ? { findLiveProxy: async () => live } : {}) });
      const result = await runtimeRequest(`/api/chatgpt-network/${options.action}`, {
        method: options.action === "status" ? "GET" : "POST", signal: AbortSignal.timeout(20_000),
      }, { ...deps, baseUrl });
      console.log(JSON.stringify(result, null, 2)); return 0;
    }
    if (options.action === "enable") throw new Error("Start the updated OpenCodex server before enabling cloud network.");
    const { readConfigDiagnostics, mutatePersistedConfig } = await import("../config");
    if (options.action !== "status") {
      const saved = mutatePersistedConfig(config => {
        if (!config.chatgptDesktop?.cloudNetwork) return { changed: false, value: undefined };
        config.chatgptDesktop = { ...config.chatgptDesktop, cloudNetwork: false };
        return { changed: true, value: undefined };
      });
      if (saved.status === "unavailable" && saved.reason !== "missing") throw new Error("Configuration could not be disabled; inspect the config before recovery.");
    }
    let helper;
    try { helper = await cloudHelperRequest(options.action === "status" ? "status" : "recover"); }
    catch {
      console.log(JSON.stringify({ configured: readConfigDiagnostics().config.chatgptDesktop?.cloudNetwork === true,
        runtime: "stopped", helper: "unavailable", mapping: "unverified", applicationHandshake: "unverified" }));
      return options.action === "status" ? 0 : 1;
    }
    console.log(JSON.stringify({ configured: readConfigDiagnostics().config.chatgptDesktop?.cloudNetwork === true,
      runtime: "stopped", helper, applicationHandshake: "unverified" }, null, 2));
    return helper.ok ? 0 : 1;
  } catch (error) {
    console.error(error instanceof CloudNetworkError ? `Cloud network: ${error.message}` : error instanceof Error ? error.message : "Cloud network operation failed");
    return 1;
  }
}
