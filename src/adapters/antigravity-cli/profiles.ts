import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import type { OcxProviderConfig } from "../../types";
import {
  clearCodingAgentBinaryCache,
  whichFromPath,
  type CodingAgentProviderProfile,
  type WhichFn,
} from "../coding-agent/profile";

/**
 *Collapsed picker models exposed by `antigravity-cli`.
 *
 * Intentionally restricted to the three Gemini 4 agent families served by the official `agy` CLI:
 * Carbon (`low`/`medium`/`high`), Argon (`low`/`medium`/`high`), and Hydrogen
 * (`low`/`medium`/`high`/`xhigh`).
 */
export const ANTIGRAVITY_CLI_MODELS = [
  "gemini-4-carbon",
  "gemini-4-argon",
  "gemini-4-hydrogen",
] as const;

export type AntigravityCliModelId = (typeof ANTIGRAVITY_CLI_MODELS)[number];
export type AntigravityCliTier = "low" | "medium" | "high" | "xhigh";

export const ANTIGRAVITY_CLI_DEFAULT_MODEL: AntigravityCliModelId = "gemini-4-carbon";
export const ANTIGRAVITY_CLI_CONTEXT_WINDOW = 1_048_576;
export const ANTIGRAVITY_CLI_MAX_OUTPUT_TOKENS = 65_536;

export const ANTIGRAVITY_CLI_REASONING_EFFORTS: readonly AntigravityCliTier[] = [
  "low",
  "medium",
  "high",
  "xhigh",
];

export const ANTIGRAVITY_CLI_MODEL_REASONING_EFFORTS: Readonly<Record<AntigravityCliModelId, string[]>> = {
  "gemini-4-carbon": ["low", "medium", "high"],
  "gemini-4-argon": ["low", "medium", "high"],
  "gemini-4-hydrogen": ["low", "medium", "high", "xhigh"],
};

export const ANTIGRAVITY_CLI_MODEL_DEFAULT_REASONING_EFFORTS: Readonly<Record<AntigravityCliModelId, AntigravityCliTier>> = {
  "gemini-4-carbon": "medium",
  "gemini-4-argon": "medium",
  "gemini-4-hydrogen": "high",
};

export const ANTIGRAVITY_CLI_MODEL_CONTEXT_WINDOWS: Readonly<Record<AntigravityCliModelId, number>> = {
  "gemini-4-carbon": ANTIGRAVITY_CLI_CONTEXT_WINDOW,
  "gemini-4-argon": ANTIGRAVITY_CLI_CONTEXT_WINDOW,
  "gemini-4-hydrogen": ANTIGRAVITY_CLI_CONTEXT_WINDOW,
};

export const ANTIGRAVITY_CLI_MODEL_MAX_OUTPUT_TOKENS: Readonly<Record<AntigravityCliModelId, number>> = {
  "gemini-4-carbon": ANTIGRAVITY_CLI_MAX_OUTPUT_TOKENS,
  "gemini-4-argon": ANTIGRAVITY_CLI_MAX_OUTPUT_TOKENS,
  "gemini-4-hydrogen": ANTIGRAVITY_CLI_MAX_OUTPUT_TOKENS,
};

/** Inline base64 raster images are staged into `.ocx-images/` and hydrated via read-only `view_file`. */
export const ANTIGRAVITY_CLI_MODEL_INPUT_MODALITIES: Readonly<Record<AntigravityCliModelId, Array<"text" | "image">>> = {
  "gemini-4-carbon": ["text", "image"],
  "gemini-4-argon": ["text", "image"],
  "gemini-4-hydrogen": ["text", "image"],
};

export type AntigravityCliProfile = CodingAgentProviderProfile & {
  readonly family: "antigravity";
  readonly region: "global";
  readonly tokenEnv?: undefined;
};

export const ANTIGRAVITY_CLI_PROFILE: AntigravityCliProfile = {
  providerId: "antigravity-cli",
  family: "antigravity",
  region: "global",
  label: "Antigravity CLI",
  canonicalBaseUrl: "https://antigravity.google",
  binaryCandidates: ["agy"],
  installHint:
    "curl -fsSL https://antigravity.google/cli/install.sh | sh (macOS/Linux) or irm https://antigravity.google/cli/install.ps1 | iex (Windows PowerShell), then run `agy` once to sign in",
  documentationUrl: "https://antigravity.google/docs/cli/reference",
};

export const ANTIGRAVITY_CLI_PROFILES: readonly AntigravityCliProfile[] = [ANTIGRAVITY_CLI_PROFILE];

export const clearAntigravityCliBinaryCache = clearCodingAgentBinaryCache;

const MODEL_SET: ReadonlySet<string> = new Set<string>(ANTIGRAVITY_CLI_MODELS);

export function isAntigravityCliModel(modelId: string): modelId is AntigravityCliModelId {
  return MODEL_SET.has(modelId);
}

function normalizeAntigravityCliTier(
  baseId: AntigravityCliModelId,
  effort: string,
): AntigravityCliTier | undefined {
  const lower = effort.trim().toLowerCase();
  if (!lower) return undefined;
  if (lower === "none" || lower === "minimal" || lower === "low") return "low";
  if (lower === "medium") return "medium";
  if (lower === "high") return "high";
  if (lower === "xhigh" || lower === "max" || lower === "ultra") {
    return baseId === "gemini-4-hydrogen" ? "xhigh" : "high";
  }
  return undefined;
}

function mappedProviderEffort(
  provider: OcxProviderConfig,
  baseId: AntigravityCliModelId,
  requestedEffort: string,
): { found: true; mapped: string } | { found: false } {
  const map = provider.modelReasoningEffortMap;
  if (!map || typeof map !== "object" || !Object.hasOwn(map, baseId)) return { found: false };
  const perModel = map[baseId];
  if (!perModel || typeof perModel !== "object") return { found: false };
  const key = requestedEffort.trim().toLowerCase();
  if (!Object.hasOwn(perModel, key)) return { found: false };
  const value = perModel[key];
  return typeof value === "string" ? { found: true, mapped: value } : { found: false };
}

/**
 * Resolve one requested collapsed model + reasoning effort to the exact `--model` slug `agy`
 * accepts, or `undefined` when the model is outside the three permitted Gemini 4 base IDs.
 */
export function resolveAntigravityCliModelSlug(
  modelId: string,
  provider: OcxProviderConfig,
  requestedEffort?: string,
): string | undefined {
  const baseId = modelId.trim();
  if (!isAntigravityCliModel(baseId)) return undefined;
  const defaultTier = ANTIGRAVITY_CLI_MODEL_DEFAULT_REASONING_EFFORTS[baseId];

  if (typeof requestedEffort === "string" && requestedEffort.trim().length > 0) {
    const custom = mappedProviderEffort(provider, baseId, requestedEffort);
    if (custom.found) {
      const tier = normalizeAntigravityCliTier(baseId, custom.mapped) ?? defaultTier;
      return `${baseId}-${tier}`;
    }
    const tier = normalizeAntigravityCliTier(baseId, requestedEffort) ?? defaultTier;
    return `${baseId}-${tier}`;
  }

  return `${baseId}-${defaultTier}`;
}

/**
 * Official Antigravity CLI installers place `agy` under `%LOCALAPPDATA%\agy\bin\agy.exe` on
 * Windows and `~/.local/bin/agy` on macOS/Linux even when a background service has an older PATH.
 */
export function findAntigravityCliBinary(
  candidate: string,
  pathLookup: WhichFn = whichFromPath,
  userHome = homedir(),
  platform: NodeJS.Platform = process.platform,
  localAppData = process.env.LOCALAPPDATA,
  exists: (path: string) => boolean = existsSync,
): string | undefined {
  const onPath = pathLookup(candidate);
  if (onPath || candidate !== "agy") return onPath;
  if (platform === "win32") {
    const appDataRoot = localAppData && localAppData.trim().length > 0
      ? localAppData.trim()
      : win32.join(userHome, "AppData", "Local");
    const candidates = [
      win32.join(appDataRoot, "agy", "bin", "agy.exe"),
      win32.join(userHome, ".local", "bin", "agy.exe"),
    ];
    for (const full of candidates) {
      try {
        if (exists(full)) return full;
      } catch {
        // Unreadable fallback locations are skipped rather than aborting preflight.
      }
    }
    return undefined;
  }
  const posixPath = posix.join(userHome, ".local", "bin", "agy");
  try {
    return exists(posixPath) ? posixPath : undefined;
  } catch {
    return undefined;
  }
}
