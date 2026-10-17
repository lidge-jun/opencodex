import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import {
  clearCodingAgentBinaryCache,
  resolveProfileByBaseUrl,
  whichFromPath,
  type CodingAgentProviderProfile,
  type WhichFn,
} from "../coding-agent/profile";

/**
 * Official StepCode CLI (阶跃星辰) as a transport for a Step Plan subscription.
 *
 * StepCode has no region-scoped variants in this registry: `step login` records one profile
 * (`step_plan`, `step_plan_oversea`, `platform_cn`, `platform_oversea`) inside the CLI's own
 * `auth.json`, and the CLI is the only component that reads it. The registry therefore selects the
 * profile by provider id, not by URL, and fails closed on any destination the CLI does not own.
 */
export interface StepCliProfile extends CodingAgentProviderProfile {
  family: "step";
}

export const STEP_CLI_PROFILE: StepCliProfile = {
  providerId: "step-cli",
  family: "step",
  region: "global",
  label: "StepCode CLI (subscription)",
  /**
   * The destination the subscription's traffic actually reaches. OpenCodex never sends this host:
   * the CLI performs every request, so the value exists to fail closed when a row is repointed at
   * something this adapter cannot speak to.
   */
  canonicalBaseUrl: "https://api.stepfun.com/step_plan",
  /**
   * StepCode installs itself to `~/.stepcode/bin/step` rather than onto PATH, so the PATH scan is
   * only the first attempt — see {@link findStepCliBinary}.
   */
  binaryCandidates: ["step"],
  /**
   * Deliberately absent: the CLI owns its sign-in (`step login`), so this provider neither requires
   * nor injects a credential and has no secret to redact. Mirrors the `claude-cli` row.
   */
  installHint: "install the StepCode CLI, then sign in once with `step login`",
  documentationUrl: "https://platform.stepfun.com/docs/zh/step-plan/quick-start",
};

export const STEP_CLI_PROFILES: readonly StepCliProfile[] = [STEP_CLI_PROFILE];

export function resolveStepCliProfile(baseUrl: string | undefined): StepCliProfile | undefined {
  return resolveProfileByBaseUrl(STEP_CLI_PROFILES, baseUrl) as StepCliProfile | undefined;
}

export const clearStepCliBinaryCache = clearCodingAgentBinaryCache;

/**
 * Locate the StepCode executable before any request is dispatched.
 *
 * The self-install location is checked after PATH and only for the bare `step` candidate: a PATH
 * entry an operator added by hand wins, while a service or GUI launch with a stale PATH still finds
 * the install it owns. Mirrors {@link findClaudeCliBinary}'s ordering.
 */
export function findStepCliBinary(
  candidate: string,
  pathLookup: WhichFn = whichFromPath,
  userHome = homedir(),
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const onPath = pathLookup(candidate);
  if (onPath || candidate !== "step") return onPath;
  const installed = join(userHome, ".stepcode", "bin", platform === "win32" ? "step.exe" : "step");
  return existsSync(installed) ? installed : undefined;
}

/**
 * Flags that make one headless turn independent of the operator's StepCode setup.
 *
 * The contract is deliberately total rather than selective. StepCode otherwise loads the user's
 * extensions, skills, prompt templates, themes, `AGENTS.md`/`CLAUDE.md` context files and every MCP
 * server in `~/.stepcode/config.toml` — a 40-server host config turns a proxied turn into a
 * multi-second startup whose tools and prompts are not part of this provider's advertised contract.
 * Tool ownership is the reason for the whole route, so `--no-tools` is not a limitation here: the
 * client's catalog is declared over the SDK stdio protocol instead.
 */
export const STEP_CLI_ISOLATION_ARGS: readonly string[] = Object.freeze([
  "--no-tools",
  "--no-extensions",
  "--no-skills",
  "--no-prompt-templates",
  "--no-themes",
  "--no-context-files",
  "--no-session",
  "--no-update-check",
]);

/** Spawn arguments for one `step` process. Isolated by construction, not by post-hoc filtering. */
export function buildStepCliArgs(model: string | undefined, thinkingLevel: string | undefined): string[] {
  const args = ["--sdk-stdio", ...STEP_CLI_ISOLATION_ARGS];
  if (model) args.push("--model", model);
  if (thinkingLevel) args.push("--thinking", thinkingLevel);
  return args;
}

/**
 * Per-turn working directory for the state this proxy owns.
 *
 * Only session files are redirected. The CLI's own config directory — and with it `auth.json` — is
 * deliberately left where StepCode put it: copying a credential into `~/.opencodex` to satisfy a
 * convenience would put a second copy of a live subscription token on disk and hand this adapter a
 * secret to redact, which is the exact posture the `claude-cli` row refuses (§三十一). Host MCP
 * servers in the operator's config may therefore still initialize; `--no-tools` is what makes them
 * unreachable, and permission mode and model are set per query regardless of what the file says.
 */
export function stepCliStateRoot(openCodexHome: string): string {
  return join(openCodexHome, "step-cli");
}

/**
 * Directory holding proxied session files.
 *
 * Redirecting this keeps proxied turns out of the operator's own `~/.stepcode/agent/sessions`
 * tree, so a conversation driven through the proxy is never mistaken for a local `step` session and
 * can be reaped without touching real history.
 */
export function stepCliSessionDir(openCodexHome: string): string {
  return join(stepCliStateRoot(openCodexHome), "sessions");
}

/** Default state root when the proxy has not published one. */
export function defaultStepCliStateRoot(): string {
  return join(tmpdir(), "opencodex-step-cli");
}
