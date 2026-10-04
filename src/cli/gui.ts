import type { OcxConfig } from "../types";
import { canonicalGuiBrowserOrigin, standaloneGuiPairingOrigin } from "../lib/gui-pair-capability";
import { findLiveProxy, type LiveProxy } from "../server/proxy-liveness";
import {
  requestBoundGuiPairingGrant,
  type GuiPairClientDeps,
  type GuiPairRequestResult,
} from "./gui-pair-client";
import type { RuntimeApiDeps } from "./runtime-api";

const GUI_USAGE = "ocx gui [pair --origin <browser-origin> [--json]]";
const PAIRING_WARNING = "Pairing grants are secret, single-use, and expire quickly. Do not save them.";

export interface GuiCommandDeps extends RuntimeApiDeps {
  openDefaultGui: () => Promise<number>;
  loadConfig: () => OcxConfig;
  findLiveProxy?: () => Promise<LiveProxy | null>;
  requestPairingGrant?: (
    target: LiveProxy,
    browserOrigin: string,
    deps?: GuiPairClientDeps,
  ) => Promise<GuiPairRequestResult>;
}

function allowedPairingOrigin(origin: string, config: OcxConfig): boolean {
  if (config.runtimeRole !== "hub") return standaloneGuiPairingOrigin(config) === origin;
  if (canonicalGuiBrowserOrigin(config.hub?.managementPublicOrigin) === origin) return true;
  return (config.corsAllowOrigins ?? []).some(value => canonicalGuiBrowserOrigin(value) === origin);
}

function parsePairArgs(args: string[]): { origin: string; json: boolean } | null {
  let origin: string | undefined;
  let json = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--json" && !json) {
      json = true;
      continue;
    }
    if (arg === "--origin" && origin === undefined) {
      const value = args[++index];
      if (!value || value.startsWith("--")) return null;
      origin = value;
      continue;
    }
    return null;
  }
  return origin ? { origin, json } : null;
}

export async function runGuiCommand(args: string[], deps: GuiCommandDeps): Promise<number> {
  if (args.length === 0) return deps.openDefaultGui();
  if (args[0] !== "pair") {
    console.error(`Usage: ${GUI_USAGE}`);
    return 1;
  }
  const parsed = parsePairArgs(args.slice(1));
  const canonicalOrigin = parsed ? canonicalGuiBrowserOrigin(parsed.origin) : null;
  if (!parsed || !canonicalOrigin || canonicalOrigin !== parsed.origin) {
    console.error(`Usage: ${GUI_USAGE}`);
    return 1;
  }
  const config = deps.loadConfig();
  if (!allowedPairingOrigin(canonicalOrigin, config)) {
    console.error("Pairing requires the standalone configured literal loopback origin, or an allowed hub origin.");
    return 1;
  }
  const target = await (deps.findLiveProxy ?? findLiveProxy)();
  if (!target) {
    console.error("No running attested OpenCodex proxy is available for GUI pairing.");
    return 1;
  }
  if ((config.runtimeRole ?? "standalone") === "standalone"
    && (target.port !== config.port || (target.hostname ?? "127.0.0.1") !== (config.hostname ?? "127.0.0.1"))) {
    console.error("Standalone pairing requires the running proxy to use its configured loopback address and port.");
    return 1;
  }
  const result = await (deps.requestPairingGrant ?? requestBoundGuiPairingGrant)(target, canonicalOrigin, {
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
  });
  if (result.kind !== "created") {
    console.error(`GUI pairing failed (${result.reason}).`);
    return 1;
  }
  if (parsed.json) {
    console.log(JSON.stringify({ ...result, warning: PAIRING_WARNING }));
  } else {
    console.log(result.grant);
    console.error(PAIRING_WARNING);
  }
  return 0;
}
