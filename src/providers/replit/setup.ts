import {
  ConfigMutationLockError,
  adoptPersistedProviderIntoLiveConfig,
  mutatePersistedConfig,
  readConfigAdmissionSnapshot,
  type PersistedConfigMutationOutcome,
} from "../../config";
import { codexAccountNamespaceProviderCollisionError } from "../../codex/account-namespace-match";
import { providerDestinationConfigError, providerDestinationResolvedError } from "../../lib/destination-policy";
import { providerManagementConfigError } from "../../server/auth-cors";
import { apiKeyPoolEntryId, sanitizeApiKeyValue } from "../api-keys";
import type { OcxConfig, OcxProviderConfig } from "../../types";
import {
  MAX_REPLIT_GATEWAY_KEY_LENGTH,
  MIN_REPLIT_GATEWAY_KEY_LENGTH,
  REPLIT_ANTHROPIC_PROVIDER_ID,
  REPLIT_DERIVED_PROVIDER_FIELDS,
  REPLIT_GATEWAY_KEY_PATTERN,
  REPLIT_OPENAI_PROVIDER_ID,
  REPLIT_PROVIDER_PAIR_IDS,
} from "./constants";
import { deriveReplitProviderPair } from "./derive";
import type { ValidatedReplitOrigin } from "./origin";
import { validateReplitOrigin } from "./origin";
import { probeReplitGateway, type ReplitGatewayProbeSuccess } from "./probe";
import { preserveReplitCustomHeaders } from "./headers";

export type { ReplitDerivedProvider, ReplitProviderPair } from "./derive";
export { deriveReplitProviderPair, setReplitRegistrySeedTestHooks } from "./derive";
export {
  buildReplitGatewayProbeRequests,
  probeReplitGateway,
  type ReplitGatewayProbeFailure,
  type ReplitGatewayProbeResult,
} from "./probe";
export {
  isReplitCredentialHeader,
  preserveReplitCustomHeaders,
  REPLIT_CREDENTIAL_HEADER_NAMES,
} from "./headers";

export interface ReplitProviderCollision {
  providerId: typeof REPLIT_PROVIDER_PAIR_IDS[number];
}

export interface ReplitProviderPairInput {
  origin: string;
  gatewayKey: string;
  allowCustomDomain?: boolean;
  replace?: boolean;
  setDefault?: boolean;
}

export type MutatePersistedConfigFn = typeof mutatePersistedConfig;

export interface InstallReplitProviderPairDeps {
  probe?: typeof probeReplitGateway;
  mutatePersistedConfig?: MutatePersistedConfigFn;
  /** Test-only fetch injection for gateway probes. Production uses pinned outbound transport. */
  probeFetch?: typeof globalThis.fetch;
}

export type InstallReplitProviderPairResult =
  | { ok: true; providers: string[]; probe: ReplitGatewayProbeSuccess }
  | {
      ok: false;
      code:
        | "invalid_origin"
        | "invalid_gateway_key"
        | "provider_collision"
        | "namespace_collision"
        | "destination_rejected"
        | "probe_failed"
        | "config_busy"
        | "persist_failed"
        | "config_unavailable";
      error: string;
      collisions?: ReplitProviderCollision[];
      probe?: import("./probe").ReplitGatewayProbeResult;
    };

const DERIVED_FIELD_SET = new Set<string>(REPLIT_DERIVED_PROVIDER_FIELDS);
const PERSIST_FAILED_MESSAGE = "failed to persist replit provider pair";

export function validateReplitGatewayKey(raw: unknown): { ok: true; key: string } | { ok: false; error: string } {
  const key = sanitizeApiKeyValue(raw);
  if (!key || key.length < MIN_REPLIT_GATEWAY_KEY_LENGTH) {
    return {
      ok: false,
      error: `gateway key must be at least ${MIN_REPLIT_GATEWAY_KEY_LENGTH} characters`,
    };
  }
  if (key.length > MAX_REPLIT_GATEWAY_KEY_LENGTH) {
    return {
      ok: false,
      error: `gateway key must be at most ${MAX_REPLIT_GATEWAY_KEY_LENGTH} characters`,
    };
  }
  if (!REPLIT_GATEWAY_KEY_PATTERN.test(key)) {
    return { ok: false, error: "gateway key must contain only printable ASCII characters" };
  }
  return { ok: true, key };
}

export function detectReplitPairCollisions(config: OcxConfig): ReplitProviderCollision[] {
  const collisions: ReplitProviderCollision[] = [];
  for (const providerId of REPLIT_PROVIDER_PAIR_IDS) {
    if (config.providers[providerId]) collisions.push({ providerId });
  }
  return collisions;
}

function collisionError(collisions: ReplitProviderCollision[]): string {
  const names = collisions.map(row => row.providerId).join(", ");
  return `replit provider pair already exists (${names}); set replace to true to overwrite`;
}

function namespaceCollisionError(config: OcxConfig): string | undefined {
  for (const providerId of REPLIT_PROVIDER_PAIR_IDS) {
    const error = codexAccountNamespaceProviderCollisionError(config.codexAccountNamespaces, providerId);
    if (error) return error;
  }
  return undefined;
}

function activeGatewayKeyPool(gatewayKey: string): NonNullable<OcxProviderConfig["apiKeyPool"]> {
  return [{ id: apiKeyPoolEntryId(gatewayKey), key: gatewayKey }];
}

export function preserveReplitProviderOverlays(
  existing: OcxProviderConfig | undefined,
  derived: OcxProviderConfig,
  gatewayKey: string,
): OcxProviderConfig {
  const next: OcxProviderConfig = { ...derived, apiKey: gatewayKey, apiKeyPool: activeGatewayKeyPool(gatewayKey) };
  if (!existing) return next;
  for (const [key, value] of Object.entries(existing) as [keyof OcxProviderConfig, unknown][]) {
    if (DERIVED_FIELD_SET.has(key) || value === undefined) continue;
    if (key === "headers") {
      const preservedHeaders = preserveReplitCustomHeaders(value as Record<string, string>);
      if (preservedHeaders) next.headers = preservedHeaders;
      continue;
    }
    (next as unknown as Record<string, unknown>)[key] = structuredClone(value);
  }
  return next;
}

function applyPairMutation(
  persisted: OcxConfig,
  origin: ValidatedReplitOrigin,
  gatewayKey: string,
  input: ReplitProviderPairInput,
):
  | ReplitProviderCollision[]
  | { kind: "namespace_collision"; error: string }
  | { kind: "destination_rejected"; error: string }
  | "invalid_provider"
  | null {
  const collisions = detectReplitPairCollisions(persisted);
  if (collisions.length > 0 && input.replace !== true) return collisions;

  const namespaceError = namespaceCollisionError(persisted);
  if (namespaceError) return { kind: "namespace_collision", error: namespaceError };

  const pair = deriveReplitProviderPair(origin);
  for (const entry of [pair.openai, pair.anthropic]) {
    const destinationError = providerDestinationConfigError(entry.name, entry.provider);
    if (destinationError) return { kind: "destination_rejected", error: destinationError };
    const providerError = providerManagementConfigError(entry.name, {
      ...preserveReplitProviderOverlays(persisted.providers[entry.name], {
        ...entry.provider,
        apiKey: gatewayKey,
      }, gatewayKey),
    });
    if (providerError) return "invalid_provider";
  }

  persisted.providers[REPLIT_OPENAI_PROVIDER_ID] = preserveReplitProviderOverlays(
    persisted.providers[REPLIT_OPENAI_PROVIDER_ID],
    { ...pair.openai.provider, apiKey: gatewayKey },
    gatewayKey,
  );
  persisted.providers[REPLIT_ANTHROPIC_PROVIDER_ID] = preserveReplitProviderOverlays(
    persisted.providers[REPLIT_ANTHROPIC_PROVIDER_ID],
    { ...pair.anthropic.provider, apiKey: gatewayKey },
    gatewayKey,
  );

  if (input.setDefault === true) {
    if (persisted.providers[REPLIT_OPENAI_PROVIDER_ID]?.disabled) {
      return "invalid_provider";
    }
    persisted.defaultProvider = REPLIT_OPENAI_PROVIDER_ID;
  }

  return null;
}

function adoptCommittedPair(liveConfig: OcxConfig): boolean {
  const admitted = readConfigAdmissionSnapshot();
  if (admitted.kind !== "read" || admitted.diagnostics.error !== null) return false;
  const persisted = admitted.diagnostics.config;
  for (const providerId of REPLIT_PROVIDER_PAIR_IDS) {
    const provider = persisted.providers[providerId];
    if (!provider) return false;
    adoptPersistedProviderIntoLiveConfig(liveConfig, providerId, provider, persisted);
  }
  if (persisted.defaultProvider) liveConfig.defaultProvider = persisted.defaultProvider;
  return true;
}

function mapMutationUnavailable<T>(
  outcome: Extract<PersistedConfigMutationOutcome<T>, { status: "unavailable" }>,
): InstallReplitProviderPairResult {
  if (outcome.reason === "conflict") {
    return {
      ok: false,
      code: "config_busy",
      error: "Configuration is busy; retry shortly",
    };
  }
  return {
    ok: false,
    code: "config_unavailable",
    error: outcome.reason === "missing"
      ? "configuration file is unavailable"
      : "configuration file is invalid",
  };
}

export async function installReplitProviderPair(
  liveConfig: OcxConfig,
  input: ReplitProviderPairInput,
  deps: InstallReplitProviderPairDeps = {},
): Promise<InstallReplitProviderPairResult> {
  const originResult = validateReplitOrigin(input.origin, {
    allowCustomDomain: input.allowCustomDomain === true,
  });
  if (!originResult.ok) {
    return { ok: false, code: "invalid_origin", error: originResult.error };
  }

  const gatewayKeyResult = validateReplitGatewayKey(input.gatewayKey);
  if (!gatewayKeyResult.ok) {
    return { ok: false, code: "invalid_gateway_key", error: gatewayKeyResult.error };
  }
  const gatewayKey = gatewayKeyResult.key;

  const pair = deriveReplitProviderPair(originResult.origin);
  for (const entry of [pair.openai, pair.anthropic]) {
    const destinationError = await providerDestinationResolvedError(entry.name, entry.provider);
    if (destinationError) {
      return { ok: false, code: "destination_rejected", error: destinationError };
    }
  }

  const probeFn = deps.probe ?? probeReplitGateway;
  const probe = await probeFn(
    originResult.origin,
    gatewayKey,
    deps.probeFetch ? { fetch: deps.probeFetch } : {},
  );
  if (!probe.ok) {
    return {
      ok: false,
      code: "probe_failed",
      error: probe.error,
      probe,
    };
  }

  const mutateFn = deps.mutatePersistedConfig ?? mutatePersistedConfig;
  type MutationFailure = Extract<InstallReplitProviderPairResult, { ok: false }>;
  const mutationState: {
    failure: Pick<MutationFailure, "code" | "error" | "collisions"> | null;
  } = { failure: null };

  try {
    const outcome = mutateFn(persisted => {
      const failure = applyPairMutation(persisted, originResult.origin, gatewayKey, input);
      if (Array.isArray(failure)) {
        mutationState.failure = {
          code: "provider_collision",
          error: collisionError(failure),
          collisions: failure,
        };
        return { changed: false, value: null };
      }
      if (failure && typeof failure === "object" && failure.kind === "namespace_collision") {
        mutationState.failure = { code: "namespace_collision", error: failure.error };
        return { changed: false, value: null };
      }
      if (failure && typeof failure === "object" && failure.kind === "destination_rejected") {
        mutationState.failure = { code: "destination_rejected", error: failure.error };
        return { changed: false, value: null };
      }
      if (failure === "invalid_provider") {
        mutationState.failure = { code: "persist_failed", error: PERSIST_FAILED_MESSAGE };
        return { changed: false, value: null };
      }
      return { changed: true, value: null };
    });

    if (mutationState.failure) {
      const failure = mutationState.failure;
      return {
        ok: false,
        code: failure.code,
        error: failure.error,
        ...(failure.collisions ? { collisions: failure.collisions } : {}),
        probe,
      };
    }

    if (outcome.status === "unavailable") {
      return { ...mapMutationUnavailable(outcome), probe };
    }
    if (outcome.status !== "committed") {
      return { ok: false, code: "persist_failed", error: PERSIST_FAILED_MESSAGE, probe };
    }

    if (!deps.mutatePersistedConfig) {
      if (!adoptCommittedPair(liveConfig)) {
        return { ok: false, code: "persist_failed", error: PERSIST_FAILED_MESSAGE, probe };
      }
    }

    return {
      ok: true,
      providers: [...REPLIT_PROVIDER_PAIR_IDS],
      probe,
    };
  } catch (error) {
    if (error instanceof ConfigMutationLockError) {
      return {
        ok: false,
        code: "config_busy",
        error: "Configuration is busy; retry shortly",
        probe,
      };
    }
    return {
      ok: false,
      code: "persist_failed",
      error: PERSIST_FAILED_MESSAGE,
      probe,
    };
  }
}
