/**
 * Validation and in-memory application of `PATCH /api/protocols/settings`.
 *
 * Pure with respect to I/O: the route persists through `saveConfigPreservingClaudeCode` and
 * restores the snapshot taken here when the save fails, so a refused write never leaves the
 * live config serving a state the file does not hold.
 *
 * The one asymmetric rule is the Messages surface. Closing it writes
 * `apiSurfaces.messages.enabled = false` AND `claudeCode.enabled = false` in the same save:
 * a binary older than `apiSurfaces` reads only `claudeCode.enabled`, so a rollback after a
 * close must still find the endpoint closed. Opening writes only the explicit surface value;
 * an older binary then keeps reading `claudeCode.enabled`, which errs closed.
 */
import { commitClaudeCodeBlock } from "../../claude/claude-code-block";
import type { ProtocolRolloutSettings, UnrepresentablePolicy } from "../../protocols/settings";
import type { OcxConfig } from "../../types";

export interface ProtocolSettingsPatch {
  messagesEnabled?: boolean;
  unrepresentable?: UnrepresentablePolicy;
  rollout?: Partial<ProtocolRolloutSettings>;
}

export type ParsedProtocolSettingsPatch =
  | { ok: true; patch: ProtocolSettingsPatch }
  | { ok: false; code: string; message: string };

const PATCH_KEYS = new Set(["messagesEnabled", "unrepresentable", "rollout"]);
export const PROTOCOL_ROLLOUT_KEYS = [
  "nativeChatCombos",
  "managedMessagesNative",
  "managedMessagesNativeOAuth",
  "directEncoders",
  "shadowPlan",
] as const satisfies readonly (keyof ProtocolRolloutSettings)[];
const ROLLOUT_KEYS = new Set<string>(PROTOCOL_ROLLOUT_KEYS);

type Rec = Record<string, unknown>;
function isRec(value: unknown): value is Rec {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function invalid(code: string, message: string): ParsedProtocolSettingsPatch {
  return { ok: false, code, message };
}

/** Strict: unknown keys and wrong types are refused; messages name the field, never the value. */
export function parseProtocolSettingsPatch(body: unknown): ParsedProtocolSettingsPatch {
  if (!isRec(body)) return invalid("invalid_body", "body must be a JSON object");
  const keys = Object.keys(body);
  if (keys.length === 0) return invalid("empty_body", "body must set messagesEnabled, unrepresentable or rollout");
  for (const key of keys) {
    if (!PATCH_KEYS.has(key)) return invalid("unknown_field", "body accepts only messagesEnabled, unrepresentable and rollout");
  }
  const patch: ProtocolSettingsPatch = {};
  if (body.messagesEnabled !== undefined) {
    if (typeof body.messagesEnabled !== "boolean") return invalid("invalid_messages_enabled", "messagesEnabled must be a boolean");
    patch.messagesEnabled = body.messagesEnabled;
  }
  if (body.unrepresentable !== undefined) {
    if (body.unrepresentable !== "legacy" && body.unrepresentable !== "reject") {
      return invalid("invalid_unrepresentable", "unrepresentable must be \"legacy\" or \"reject\"");
    }
    patch.unrepresentable = body.unrepresentable;
  }
  if (body.rollout !== undefined) {
    if (!isRec(body.rollout)) return invalid("invalid_rollout", "rollout must be an object");
    const rollout: Partial<ProtocolRolloutSettings> = {};
    for (const [key, value] of Object.entries(body.rollout)) {
      if (!ROLLOUT_KEYS.has(key)) return invalid("unknown_rollout_field", `rollout accepts only ${PROTOCOL_ROLLOUT_KEYS.join(", ")}`);
      if (typeof value !== "boolean") return invalid("invalid_rollout", "rollout values must be booleans");
      rollout[key as keyof ProtocolRolloutSettings] = value;
    }
    patch.rollout = rollout;
  }
  return { ok: true, patch };
}

/** The config subtrees a patch may touch, captured so a failed save can be undone. */
export interface ProtocolSettingsSnapshot {
  apiSurfaces: unknown;
  protocols: unknown;
  claudeCode: unknown;
}

export function snapshotProtocolSettings(config: OcxConfig): ProtocolSettingsSnapshot {
  return {
    apiSurfaces: structuredClone(config.apiSurfaces),
    protocols: structuredClone(config.protocols),
    claudeCode: structuredClone(config.claudeCode),
  };
}

export function restoreProtocolSettings(config: OcxConfig, snapshot: ProtocolSettingsSnapshot): void {
  const target = config as unknown as Rec;
  for (const key of ["apiSurfaces", "protocols", "claudeCode"] as const) {
    if (snapshot[key] === undefined) delete target[key];
    else target[key] = snapshot[key];
  }
}

export type ApplyProtocolSettingsResult =
  | { ok: true; claudeCodeChanged: boolean }
  | { ok: false; code: string; message: string };

/**
 * Apply a validated patch to the live config. Checks that depend on the merged state run
 * before anything is written, so a refusal leaves the config untouched.
 */
export function applyProtocolSettingsPatch(config: OcxConfig, patch: ProtocolSettingsPatch): ApplyProtocolSettingsResult {
  const protocols: Rec = isRec(config.protocols) ? { ...config.protocols } : {};
  if (patch.rollout) {
    const rollout: Rec = { ...(isRec(protocols.rollout) ? protocols.rollout : {}), ...patch.rollout };
    // The OAuth extension is meaningless without the key-auth lane it extends; the resolver
    // would silently read it as off, so refuse turning it on alone instead of storing a switch
    // that does nothing. Turning the key-auth lane off leaves the extension inert, not wrong.
    if (patch.rollout.managedMessagesNativeOAuth === true && rollout.managedMessagesNative !== true) {
      return {
        ok: false,
        code: "rollout_dependency",
        message: "rollout.managedMessagesNativeOAuth requires rollout.managedMessagesNative",
      };
    }
    protocols.rollout = rollout;
  }
  if (patch.unrepresentable !== undefined) protocols.unrepresentable = patch.unrepresentable;
  if (patch.unrepresentable !== undefined || patch.rollout) {
    config.protocols = protocols as OcxConfig["protocols"];
  }

  let claudeCodeChanged = false;
  if (patch.messagesEnabled !== undefined) {
    // A malformed block is replaced, not merged: the explicit value is what the operator asked for.
    const surfaces: Rec = isRec(config.apiSurfaces) ? { ...config.apiSurfaces } : {};
    const messages: Rec = isRec(surfaces.messages) ? { ...surfaces.messages } : {};
    messages.enabled = patch.messagesEnabled;
    surfaces.messages = messages;
    config.apiSurfaces = surfaces as OcxConfig["apiSurfaces"];
    if (!patch.messagesEnabled && config.claudeCode?.enabled !== false) {
      commitClaudeCodeBlock(config, { ...(config.claudeCode ?? {}), enabled: false });
      claudeCodeChanged = true;
    }
  }
  return { ok: true, claudeCodeChanged };
}
