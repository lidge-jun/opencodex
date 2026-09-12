import { createHash } from "node:crypto";
import { formatErrorResponse } from "../bridge";
import type { OcxConfig } from "../types";
import { captureExplicitOpenAiCallerAuth } from "../providers/openai-sidecar";
import type { DataPlaneAdmission } from "./auth-cors";
import { resolveAudioAdmission } from "./audio-upstream";

export const AUDIO_WEBSOCKET_PROTOCOL = "opencodex-audio";
const KEY_PROTOCOL_PREFIX = "opencodex-key.";

export interface AudioClient {
  admission: DataPlaneAdmission;
  headers: Headers;
  owner: string;
  protocol?: string;
}

/** Browser protocols are an audio-only credential carrier; only the public marker is echoed. */
export function resolveAudioClient(req: Request, config: OcxConfig, required = false): AudioClient | Response | null {
  const headers = new Headers(req.headers);
  let protocol: string | undefined;
  let carrier = false;
  if (headers.get("upgrade")?.toLowerCase() === "websocket") {
    const raw = headers.get("sec-websocket-protocol") ?? "";
    if (raw.length > 8192) return formatErrorResponse(400, "invalid_request_error", "Audio protocol header too large");
    const protocols = raw.split(",").map(value => value.trim()).filter(Boolean);
    const keys = protocols.filter(value => value.startsWith(KEY_PROTOCOL_PREFIX));
    const markers = protocols.filter(value => value === AUDIO_WEBSOCKET_PROTOCOL);
    carrier = keys.length > 0 || markers.length > 0;
    if (carrier) {
      if (keys.length !== 1 || markers.length !== 1 || protocols.length !== 2) {
        return formatErrorResponse(400, "invalid_request_error", "Expected one audio protocol and one encoded client key");
      }
      const encoded = keys[0]!.slice(KEY_PROTOCOL_PREFIX.length);
      const bytes = Buffer.from(encoded, "base64url");
      const key = bytes.toString("utf8");
      if (!encoded || bytes.toString("base64url") !== encoded || Buffer.from(key).toString("base64url") !== encoded || !key.trim()) {
        return formatErrorResponse(400, "invalid_request_error", "Invalid audio client key encoding");
      }
      protocol = AUDIO_WEBSOCKET_PROTOCOL;
      if (!["authorization", "x-opencodex-api-key", "x-api-key"].some(name => headers.has(name))) {
        headers.set("x-opencodex-api-key", key);
      }
    }
  }
  const admission = resolveAudioAdmission(headers, config);
  if (!admission) {
    const explicit = headers.has("x-opencodex-api-key") || headers.has("x-api-key")
      || (headers.has("authorization") && !captureExplicitOpenAiCallerAuth(headers, config));
    return required || carrier || explicit
      ? formatErrorResponse(401, "authentication_error", "opencodex API key required")
      : null;
  }
  const credential = admission.source === "dedicated" ? headers.get("x-opencodex-api-key")
    : admission.source === "x-api-key" ? headers.get("x-api-key") : headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  const owner = admission.kind === "configured"
    ? JSON.stringify(["configured", admission.keyId])
    : JSON.stringify(["environment", createHash("sha256").update(credential?.trim() ?? "").digest("hex")]);
  return { admission, headers, owner, ...(protocol ? { protocol } : {}) };
}
