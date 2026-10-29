import { homedir } from "node:os";
import { join, win32 } from "node:path";
import { PROXY_MARKER } from "../../claude/auth-detect";
import { isLoopbackHostname, shouldInjectApiAuthHeader } from "../../codex/loopback-target";
import { resolveApiSurfaceSettings } from "../../protocols/settings";
import { absoluteClientPath, ClientPathError } from "../client-path";
import type { ExportContext, ManagedContribution, OpencodeLaunchEnv } from "./contracts";
import { OPENCODE_PROVIDER_ID } from "./constants";
import { normalizeExportModels, singleFragment } from "./model-metadata";

/**
 * T3 Code's data directory: `T3CODE_HOME` when set, otherwise `~/.t3`
 * (t3code `apps/server/src/os-jank.ts` `resolveBaseDir`). The desktop app and
 * the `t3` server share it. A relative override is refused because opencodex
 * and T3 Code would anchor it to different working directories or Windows drives.
 */
export function t3codeHomeDir(env: OpencodeLaunchEnv = process.env, home: string = homedir(), platform: NodeJS.Platform = process.platform): string {
  const override = env.T3CODE_HOME?.trim();
  if (!override) return join(home, ".t3");
  if (platform !== "win32") return absoluteClientPath(override, home, "T3CODE_HOME", platform);
  const expanded = override === "~" ? home
    : override.startsWith("~/") || override.startsWith("~\\") ? win32.join(home, override.slice(2)) : override;
  // isAbsolute also accepts \rooted paths, which still depend on the current drive.
  if (!/^[A-Za-z]:[\\/]/.test(expanded) && !/^[\\/]{2}[^\\/]+[\\/][^\\/]+(?:[\\/]|$)/.test(expanded)) {
    throw new ClientPathError(
      `T3CODE_HOME must be a fully qualified drive or UNC path, or start with ~; "${override}" depends on the working directory or drive, `
      + "so opencodex and T3 Code would disagree about which file it names.",
    );
  }
  return expanded;
}

/**
 * Server settings live in `<base>/userdata/settings.json`; T3 Code watches the file and
 * reloads it, so a written provider instance appears without a restart.
 */
export function t3codeConfigPath(env: OpencodeLaunchEnv = process.env, home: string = homedir()): string {
  return join(t3codeHomeDir(env, home), "userdata", "settings.json");
}

/** One T3 Code `ProviderInstanceEnvironmentVariable` (t3code `packages/contracts/src/providerInstance.ts`). */
export interface T3CodeEnvironmentVariable {
  name: string;
  value: string;
  sensitive: false;
}

/** One T3 Code `CustomModelEntry`: the slug is sent verbatim as the Claude model id. */
export interface T3CodeCustomModel {
  slug: string;
  name: string;
}

/** The `providerInstances.opencodex` value opencodex owns in T3 Code's settings.json. */
export interface T3CodeProviderInstance {
  driver: "claudeAgent";
  displayName: string;
  environment: T3CodeEnvironmentVariable[];
  config: { customModels: T3CodeCustomModel[] };
}

export interface T3CodeGeneratedConfig {
  providerInstances: Record<typeof OPENCODE_PROVIDER_ID, T3CodeProviderInstance>;
}

/**
 * One `claudeAgent` provider instance that runs the user's own `claude` binary against
 * the proxy's Messages surface.
 *
 * The environment matches a proxy-mode `ocx claude` launch on a loopback bind:
 * the root origin (Claude Code appends `/v1/messages`) and the non-secret marker as
 * `ANTHROPIC_AUTH_TOKEN`. `ANTHROPIC_API_KEY` is explicitly empty so a stored Anthropic
 * key cannot outrank the marker, which is T3 Code's documented router recipe.
 * `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST` stops a `settings.json` env block in the
 * user's Claude config from re-pointing this instance away from the proxy.
 *
 * Every variable is `sensitive: false` on purpose: T3 Code moves sensitive values into
 * its secret store and blanks them in settings.json, which would turn our own block into
 * a foreign edit. None of these values is a credential.
 *
 * Models are `customModels` entries keyed by the proxy selector T3 Code sends verbatim
 * as the Claude model id. The Codex driver needs no block: it lists models through
 * `codex app-server`, which already reads the routed catalog opencodex writes into
 * `CODEX_HOME`.
 */
function t3codeDocument(ctx: ExportContext): T3CodeGeneratedConfig {
  const origin = new URL(ctx.baseUrl).origin;
  const models = normalizeExportModels(ctx.models);
  const variable = (name: string, value: string): T3CodeEnvironmentVariable => ({ name, value, sensitive: false });
  return {
    providerInstances: {
      [OPENCODE_PROVIDER_ID]: {
        driver: "claudeAgent",
        displayName: "opencodex",
        environment: [
          variable("ANTHROPIC_BASE_URL", origin),
          variable("ANTHROPIC_AUTH_TOKEN", PROXY_MARKER),
          variable("ANTHROPIC_API_KEY", ""),
          variable("CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST", "1"),
        ],
        config: {
          customModels: models.map(model => ({
            slug: model.namespaced,
            name: model.displayName || model.namespaced,
          })),
        },
      },
    },
  };
}

/** Refuses any listener that needs an admission header: T3 Code would send only the marker. */
export function buildT3CodeClientConfig(ctx: ExportContext): T3CodeGeneratedConfig {
  if (shouldInjectApiAuthHeader(ctx.config) || !isLoopbackHostname(new URL(ctx.baseUrl).hostname)) {
    throw new Error("T3 Code's placeholder credential requires a loopback-only listener.");
  }
  return t3codeDocument(ctx);
}

export function summarizeT3Code(document: unknown): { modelCount: number; modelsWithoutLimits: number } {
  const models = (document as T3CodeGeneratedConfig | undefined)
    ?.providerInstances?.[OPENCODE_PROVIDER_ID]?.config?.customModels ?? [];
  return { modelCount: models.length, modelsWithoutLimits: 0 };
}

/**
 * Refuses apply and refresh while the Messages surface is closed, explicitly or through
 * the inherited `claudeCode.enabled`: every turn the instance sends would get a 403.
 * Disable and Undo stay available.
 */
export function t3codeApplyRefusal(ctx: ExportContext): string | null {
  if (resolveApiSurfaceSettings(ctx.config ?? {}).messages.enabled) return null;
  return "T3 Code needs the Messages API; turn on Messages on the API page (apiSurfaces.messages.enabled) first.";
}

export function buildT3CodeContribution(ctx: ExportContext): ManagedContribution {
  // The writer gates admission before applying. Classification and disable must
  // still work after the operator changes the proxy to a non-loopback bind.
  const doc = t3codeDocument(ctx);
  return singleFragment("t3code", ["providerInstances", OPENCODE_PROVIDER_ID], doc.providerInstances[OPENCODE_PROVIDER_ID]);
}
