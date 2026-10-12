/**
 * The single reader of `apiSurfaces` and `protocols` config.
 *
 * Nothing else reads those keys directly: endpoint admission, `count_tokens`, the endpoint
 * metadata DTO and the dashboard all resolve through here, so they cannot disagree about
 * whether an API is open. Instance admission reads only config and registry metadata;
 * this module never reads credentials or selects an account.
 */
import type { OcxConfig } from "../types";
import { configuredAnthropicInstance } from "../providers/anthropic-instance";
import type { Protocol } from "./contract";

export type ApiSurfaceSource =
  /** Responses and Chat Completions: always served. */
  | "fixed"
  /** An explicit boolean in `apiSurfaces`. */
  | "api-surfaces"
  /** No explicit value; inherited from `claudeCode.enabled`. */
  | "claude-code-legacy"
  /** A present but malformed value; the surface is closed. */
  | "invalid";

export interface ApiSurfaceSetting {
  enabled: boolean;
  source: ApiSurfaceSource;
}

export type ApiSurfaceSettings = Readonly<Record<Protocol, Readonly<ApiSurfaceSetting>>>;

type Rec = Record<string, unknown>;
function isRec(value: unknown): value is Rec {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function resolveMessagesSurface(config: Pick<OcxConfig, "apiSurfaces" | "claudeCode">): ApiSurfaceSetting {
  const raw: unknown = config.apiSurfaces;
  if (raw !== undefined) {
    if (!isRec(raw)) return { enabled: false, source: "invalid" };
    const messages = raw.messages;
    if (messages !== undefined) {
      if (!isRec(messages)) return { enabled: false, source: "invalid" };
      if (Object.hasOwn(messages, "enabled")) {
        return typeof messages.enabled === "boolean"
          ? { enabled: messages.enabled, source: "api-surfaces" }
          : { enabled: false, source: "invalid" };
      }
    }
  }
  return { enabled: config.claudeCode?.enabled !== false, source: "claude-code-legacy" };
}

export function resolveApiSurfaceSettings(config: Pick<OcxConfig, "apiSurfaces" | "claudeCode">): ApiSurfaceSettings {
  return Object.freeze({
    responses: Object.freeze({ enabled: true, source: "fixed" as const }),
    chat: Object.freeze({ enabled: true, source: "fixed" as const }),
    messages: Object.freeze(resolveMessagesSurface(config)),
  });
}

export type UnrepresentablePolicy = "legacy" | "reject";

export interface ProtocolRolloutSettings {
  nativeChatCombos: boolean;
  managedMessagesNative: boolean;
  managedMessagesNativeOAuth: boolean;
  directEncoders: boolean;
  shadowPlan: boolean;
}

export interface ProtocolSettings {
  unrepresentable: UnrepresentablePolicy;
  rollout: Readonly<ProtocolRolloutSettings>;
}

type ProtocolConfig = Pick<OcxConfig, "protocols" | "anthropicAccountPool"> & Partial<Pick<OcxConfig, "providers">>;

/** Resolve protocol policy with conservative defaults for every absent or malformed field. */
export function resolveProtocolSettings(config: ProtocolConfig, providerName?: string): Readonly<ProtocolSettings> {
  const raw: unknown = config.protocols;
  const protocols = isRec(raw) ? raw : {};
  const rollout = isRec(protocols.rollout) ? protocols.rollout : {};
  const on = (key: keyof ProtocolRolloutSettings): boolean => rollout[key] === true;
  // A present malformed container cannot become an absent/default-on policy.
  const validContainers = (raw === undefined || isRec(raw))
    && (!Object.hasOwn(protocols, "rollout") || isRec(protocols.rollout));
  const instance = configuredAnthropicInstance({ providers: config.providers ?? {} }, providerName);
  const rawPool: unknown = instance === "anthropic2"
    ? config.providers?.anthropic2?.anthropicAccountPool : instance === "anthropic" ? config.anthropicAccountPool : undefined;
  const pool = isRec(rawPool) ? rawPool : {};
  const pooled = instance !== undefined && pool.enabled === true;
  const poolPreference = !Object.hasOwn(pool, "nativeMessages") || pool.nativeMessages === true;
  const nativeOn = (key: "managedMessagesNative" | "managedMessagesNativeOAuth") => validContainers
    && (!pooled || poolPreference)
    && (Object.hasOwn(rollout, key) ? rollout[key] === true : pooled);
  const managedMessagesNative = nativeOn("managedMessagesNative");
  return Object.freeze({
    unrepresentable: protocols.unrepresentable === "reject" ? "reject" : "legacy",
    rollout: Object.freeze({
      nativeChatCombos: on("nativeChatCombos"),
      managedMessagesNative,
      // OAuth extension is meaningless without the key-auth path it extends.
      managedMessagesNativeOAuth: managedMessagesNative && nativeOn("managedMessagesNativeOAuth"),
      directEncoders: on("directEncoders"),
      shadowPlan: on("shadowPlan"),
    }),
  });
}

/**
 * Short, stable digest of every config input a protocol plan reads. Plans carry it so the
 * dashboard can tell a preview computed under an older policy from a current one. Not a
 * security boundary; FNV-1a over a canonical JSON projection.
 */
export function protocolPolicyRevision(config: ProtocolConfig & Pick<OcxConfig, "apiSurfaces" | "claudeCode">): string {
  const surfaces = resolveApiSurfaceSettings(config);
  const settings = resolveProtocolSettings(config);
  const anthropicSettings = resolveProtocolSettings(config, "anthropic");
  const secondarySettings = resolveProtocolSettings(config, "anthropic2");
  const state = (record: unknown, key: string) => !isRec(record) || !Object.hasOwn(record, key)
    ? "absent" : record[key] === true ? "true" : record[key] === false ? "false" : "invalid";
  const container = (value: unknown) => value === undefined ? "absent" : isRec(value) ? "object" : "invalid";
  const rawProtocols: unknown = config.protocols;
  const rawRollout = isRec(rawProtocols) ? rawProtocols.rollout : undefined;
  const secondary = config.providers?.anthropic2;
  const canonical = JSON.stringify({
    messages: [surfaces.messages.enabled, surfaces.messages.source],
    unrepresentable: settings.unrepresentable,
    nativeInputs: [
      container(rawProtocols), container(rawRollout),
      state(rawRollout, "managedMessagesNative"), state(rawRollout, "managedMessagesNativeOAuth"),
      container(config.anthropicAccountPool), state(config.anthropicAccountPool, "enabled"),
      state(config.anthropicAccountPool, "nativeMessages"),
      container(secondary), state(secondary, "disabled"),
      !!secondary && Object.hasOwn(secondary, "anthropicOAuthInstance"), secondary?.anthropicOAuthInstance ?? "absent",
      secondary?.adapter ?? "absent", secondary?.authMode ?? "absent", secondary?.baseUrl ?? "absent",
      container(secondary?.anthropicAccountPool), state(secondary?.anthropicAccountPool, "enabled"),
      state(secondary?.anthropicAccountPool, "nativeMessages"),
    ],
    rollout: [
      settings.rollout.nativeChatCombos,
      settings.rollout.managedMessagesNative,
      settings.rollout.managedMessagesNativeOAuth,
      anthropicSettings.rollout.managedMessagesNative,
      anthropicSettings.rollout.managedMessagesNativeOAuth,
      secondarySettings.rollout.managedMessagesNative,
      secondarySettings.rollout.managedMessagesNativeOAuth,
      settings.rollout.directEncoders,
      settings.rollout.shadowPlan,
    ],
  });
  let hash = 0x811c9dc5;
  for (let i = 0; i < canonical.length; i++) {
    hash ^= canonical.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `p1-${hash.toString(16).padStart(8, "0")}`;
}
