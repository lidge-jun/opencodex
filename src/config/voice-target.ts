/**
 * Shared target resolution for the four voice routes — dictation (mic → text over a socket),
 * transcription (a file → text), speech (text → audio) and live voice (a realtime
 * speech conversation over a socket).
 *
 * All three make the same decision: a reserved built-in name, the id of a CUSTOM provider whose
 * entry carries the endpoint, or a rejection. Writing that decision once is the point. The
 * dictation module already argued it — the CLI, the management route and the runtime dispatch
 * must agree about what a target means — and a second and third copy of the rule is exactly how
 * they would stop agreeing.
 *
 * Each route differs only in which provider fields hold its endpoint, so those live in one table.
 */
import { getProviderRegistryEntry } from "../providers/registry";
import type { OcxProviderConfig } from "../types";
import { voiceEndpointUrlConfigError } from "./provider-validation";
import { resolveEnvValue } from "./proxy-env";

export type VoiceRouteKind = "dictation" | "transcription" | "speech" | "live";

/** Which provider fields carry one route's endpoint. */
interface RouteFields {
  /** The reserved target meaning "keep the built-in OpenAI/ChatGPT path". */
  reserved: string;
  /**
   * Set when the route has no built-in backend, so the reserved name names nothing
   * servable. Still the runtime default (an absent block resolves to it and the route
   * answers 501 with a message saying what to set), but REFUSED at the write boundary:
   * an explicit value there is a mistake worth naming when it is written, not on the
   * first request.
   */
  reservedUnservable?: true;
  /** The route's config block key (`config.<key>`), used in schema error prefixes. */
  key: string;
  url: "dictationUrl" | "transcriptionUrl" | "speechUrl" | "liveUrl";
  headers: "dictationHeaders" | "transcriptionHeaders" | "speechHeaders" | "liveHeaders";
  /** WebSocket routes only. */
  protocols?: "dictationProtocols";
  /** How the route is named in error text. */
  label: string;
}

export const VOICE_ROUTES: Record<VoiceRouteKind, RouteFields> = {
  dictation: {
    reserved: "openai",
    key: "dictation",
    url: "dictationUrl",
    headers: "dictationHeaders",
    protocols: "dictationProtocols",
    label: "dictation",
  },
  transcription: {
    reserved: "openai",
    key: "transcription",
    url: "transcriptionUrl",
    headers: "transcriptionHeaders",
    label: "transcription",
  },
  speech: {
    reserved: "openai",
    reservedUnservable: true,
    key: "speech",
    url: "speechUrl",
    headers: "speechHeaders",
    label: "speech",
  },
  live: {
    reserved: "openai",
    key: "liveVoice",
    url: "liveUrl",
    headers: "liveHeaders",
    label: "live voice",
  },
};

const ROUTE_KEYS = new Set(["provider", "byModel"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export type VoiceTargetResolution =
  | { kind: "openai" }
  | { kind: "custom"; providerName: string; provider: OcxProviderConfig }
  | { kind: "invalid"; target: string; error: string };

/**
 * Resolve one target name against the configured providers.
 *
 * The reserved name always means the built-in path, even when a provider happens to share it: a
 * config that accidentally shadows `"openai"` should not silently redirect someone's microphone.
 * A registry-managed provider id is refused for the same reason `images.provider` refuses one —
 * built-ins carry no custom voice endpoint.
 */
export function resolveVoiceTarget(
  providers: Record<string, OcxProviderConfig> | undefined,
  target: string | undefined,
  kind: VoiceRouteKind,
): VoiceTargetResolution {
  const route = VOICE_ROUTES[kind];
  const providerName = target ?? route.reserved;
  if (providerName === route.reserved) return { kind: "openai" };
  if (getProviderRegistryEntry(providerName)) {
    return {
      kind: "invalid",
      target: providerName,
      error: `${route.label} provider "${providerName}" must name a custom provider; "${route.reserved}" selects the built-in path`,
    };
  }
  const provider = providers && Object.prototype.hasOwnProperty.call(providers, providerName)
    ? providers[providerName]
    : undefined;
  if (!provider) {
    return { kind: "invalid", target: providerName, error: `${route.label} provider "${providerName}" is not configured` };
  }
  return { kind: "custom", providerName, provider };
}

/**
 * A named target must actually carry a usable endpoint. Mirrors `selectImagesProvider`'s
 * post-name checks: the name resolves, but the provider is not shaped for this relay.
 */
export function voiceProviderEndpointError(
  providerName: string,
  provider: OcxProviderConfig,
  kind: VoiceRouteKind,
): string | null {
  const route = VOICE_ROUTES[kind];
  const label = `${route.label} provider "${providerName}"`;
  const url = provider[route.url];
  if (typeof url !== "string" || url.trim() === "") {
    return `${label} has no ${route.label} endpoint (set providers.${providerName}.${route.url})`;
  }
  const urlError = voiceEndpointUrlConfigError(route.url, url);
  if (urlError) return `${label} ${urlError}`;
  const headers = provider[route.headers];
  if (headers !== undefined) {
    if (!isRecord(headers) || Object.values(headers).some(value => typeof value !== "string")) {
      return `${label} ${route.headers} must be an object of strings`;
    }
  }
  if (route.protocols) {
    const protocols = provider[route.protocols];
    if (protocols !== undefined) {
      if (!Array.isArray(protocols) || !protocols.every(protocol => typeof protocol === "string")) {
        return `${label} ${route.protocols} must be an array of strings`;
      }
    }
  }
  return null;
}

/** Resolve `${ENV_VAR}` references in configured headers; drop unresolvable ones. */
export function resolveVoiceHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    const envValue = resolveEnvValue(value);
    if (envValue !== undefined) resolved[name] = envValue;
  }
  return resolved;
}

/** Validate one route's config block against the providers it may reference. */
export function voiceConfigValueError(
  value: unknown,
  providers: Record<string, OcxProviderConfig> | undefined,
  kind: VoiceRouteKind,
): string | null {
  const route = VOICE_ROUTES[kind];
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) return `schema_invalid: ${route.key}: must be an object`;
  const unknown = Object.keys(value).find(key => !ROUTE_KEYS.has(key));
  if (unknown) return `schema_invalid: ${route.key}.${unknown}: unknown key`;

  const targetError = (field: string, target: unknown): string | null => {
    if (target === undefined) return null;
    if (typeof target !== "string") return `schema_invalid: ${route.key}.${field}: must be a string`;
    const resolution = resolveVoiceTarget(providers, target, kind);
    if (resolution.kind === "invalid") return `schema_invalid: ${route.key}.${field}: ${resolution.error}`;
    // The reserved name validates as correct for dictation and transcription
    // because a real relay stands behind it. For speech nothing does: the value
    // is accepted by both write boundaries, "Config is valid" is printed, and
    // every request then answers 501 "No speech backend is configured". The
    // three blocks look identical in a file, so this is the path someone takes
    // by copying `provider: "openai"` across. Refuse it where it is written.
    if (resolution.kind === "openai" && route.reservedUnservable) {
      return `schema_invalid: ${route.key}.${field}: "${route.reserved}" names no ${route.label} backend; `
        + `omit the ${route.key} block or name a custom provider with a ${route.url}`;
    }
    if (resolution.kind === "custom") {
      const endpointError = voiceProviderEndpointError(resolution.providerName, resolution.provider, kind);
      if (endpointError) return `schema_invalid: ${route.key}.${field}: ${endpointError}`;
    }
    return null;
  };
  const providerError = targetError("provider", value.provider);
  if (providerError) return providerError;
  const byModel = value.byModel;
  if (byModel !== undefined) {
    if (!isRecord(byModel)) return `schema_invalid: ${route.key}.byModel: must be an object`;
    for (const [model, target] of Object.entries(byModel)) {
      const error = targetError(`byModel.${model}`, target);
      if (error) return error;
    }
  }
  return null;
}

/** Pick one route's backend for the active model: exact `byModel`, then `provider`, then reserved. */
export function selectVoiceBackend(
  providers: Record<string, OcxProviderConfig> | undefined,
  block: { provider?: string; byModel?: Record<string, string> } | undefined,
  modelId: string | undefined,
  kind: VoiceRouteKind,
): VoiceTargetResolution {
  const target = (modelId ? block?.byModel?.[modelId] : undefined) ?? block?.provider;
  return resolveVoiceTarget(providers, target, kind);
}
