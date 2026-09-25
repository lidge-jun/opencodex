/**
 * The single reader of `apiSurfaces` and `protocols` config.
 *
 * Nothing else reads those keys directly: endpoint admission, `count_tokens`, the endpoint
 * metadata DTO and the dashboard all resolve through here, so they cannot disagree about
 * whether an API is open. Type-only config import keeps this module free of runtime edges.
 */
import type { OcxConfig } from "../types";
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

/** Resolve protocol policy with conservative defaults for every absent or malformed field. */
export function resolveProtocolSettings(config: Pick<OcxConfig, "protocols">): Readonly<ProtocolSettings> {
  const raw: unknown = config.protocols;
  const protocols = isRec(raw) ? raw : {};
  const rollout = isRec(protocols.rollout) ? protocols.rollout : {};
  const on = (key: keyof ProtocolRolloutSettings): boolean => rollout[key] === true;
  const managedMessagesNative = on("managedMessagesNative");
  return Object.freeze({
    unrepresentable: protocols.unrepresentable === "reject" ? "reject" : "legacy",
    rollout: Object.freeze({
      nativeChatCombos: on("nativeChatCombos"),
      managedMessagesNative,
      // OAuth extension is meaningless without the key-auth path it extends.
      managedMessagesNativeOAuth: managedMessagesNative && on("managedMessagesNativeOAuth"),
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
export function protocolPolicyRevision(config: Pick<OcxConfig, "apiSurfaces" | "claudeCode" | "protocols">): string {
  const surfaces = resolveApiSurfaceSettings(config);
  const settings = resolveProtocolSettings(config);
  const canonical = JSON.stringify({
    messages: [surfaces.messages.enabled, surfaces.messages.source],
    unrepresentable: settings.unrepresentable,
    rollout: [
      settings.rollout.nativeChatCombos,
      settings.rollout.managedMessagesNative,
      settings.rollout.managedMessagesNativeOAuth,
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
