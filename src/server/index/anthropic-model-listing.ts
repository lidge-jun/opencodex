import {
  buildDesktop3pRegistry,
  desktop3pModelOptions,
  generateDesktop3pModels,
  resolvableDesktop3pAlias,
} from "../../claude/desktop-3p";
import type { DesktopDiscoveryInputs } from "../../claude/desktop-discovery-inputs";
import type { OcxConfig } from "../../types";
import { jsonResponse, type RequestPolicyView } from "../auth-cors";

export function desktopSnapshotBusyResponse(req: Request, policy: RequestPolicyView): Response {
  const response = jsonResponse({ error: {
    type: "server_error", code: "desktop_snapshot_busy", message: "Desktop model snapshot is temporarily unavailable",
  } }, 503, req, policy);
  response.headers.set("Retry-After", "1");
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export async function renderAnthropicModelListing(options: {
  req: Request;
  url: URL;
  policy: RequestPolicyView;
  config: OcxConfig;
  desktopInputs: DesktopDiscoveryInputs;
  wantsDesktopConfig: boolean;
  canInstallAliases: () => boolean;
  fastEligible: (model: { provider: string; id: string; supportsServiceTier?: boolean }) => boolean;
}): Promise<Response> {
  const { req, url, policy, config, desktopInputs, wantsDesktopConfig, canInstallAliases, fastEligible } = options;
  if (wantsDesktopConfig) {
    if (!canInstallAliases()) return desktopSnapshotBusyResponse(req, policy);
    const enabled = config.claudeCode?.enabled !== false;
    const models = enabled ? generateDesktop3pModels(
      desktopInputs.nativeSlugs, desktopInputs.routedModels,
      config.claudeCode?.desktopProfile, desktopInputs.nativeContextCap,
      desktop3pModelOptions(config.claudeCode),
    ) : [];
    const response = jsonResponse({ version: 1, models }, 200, req, policy);
    response.headers.set("Cache-Control", "no-store");
    return response;
  }
  if (config.claudeCode?.enabled === false) return jsonResponse({ data: [] }, 200, req, policy);
  const { buildAnthropicModelInfos, configuredRoutedDisplayName } = await import("../../claude/model-info");
  const { resolveAutoContext } = await import("../../claude/context-windows");
  if (canInstallAliases()) {
    buildDesktop3pRegistry(
      desktopInputs.nativeSlugs, desktopInputs.routedModels,
      config.claudeCode?.desktopProfile, desktopInputs.nativeContextCap,
    );
  }
  // Per-surface id family (devlog 050): explicit ?ids= wins; otherwise the
  // Claude Code CLI discovery UA (`claude-code/<version>`, binary n_()) gets
  // readable claude-ocx ids and every other client (Desktop 3P) keeps the
  // hashed family its config was written with. Unknown UA -> hashed (safe).
  const idsParam = url.searchParams.get("ids");
  const idStyle = idsParam === "cli"
    ? "readable" as const
    : idsParam === "desktop"
      ? "desktop3p" as const
      : (/^claude-code\//i.test(req.headers.get("user-agent") ?? "") ? "readable" as const : "desktop3p" as const);
  const data = buildAnthropicModelInfos(
    desktopInputs.nativeSlugs,
    desktopInputs.routedModels,
    resolveAutoContext(config.claudeCode),
    idStyle,
    resolvableDesktop3pAlias,
    desktopInputs.nativeContextCap,
    config.fastMode,
    // Explicit opt-out omits the Fast predicate.
    config.fastRows !== false ? fastEligible : undefined,
    { modelPickerOrder: config.modelPickerOrder, featured: config.subagentModels }, configuredRoutedDisplayName(config),
  );
  return jsonResponse({ data }, 200, req, policy);
}
