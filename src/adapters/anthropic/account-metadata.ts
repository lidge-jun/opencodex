/** Serving-account alignment for observed JSON-string Claude metadata. No body-wide matching. */
import { createHash } from "node:crypto";
const PROVIDER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_USER_ID_BYTES = 4096;
type Rec = Record<string, unknown>;
const isRec = (value: unknown): value is Rec => value !== null && typeof value === "object" && !Array.isArray(value);

/** Deterministic per-account 64-hex device_id so pooled accounts never share one client device_id. */
export function deriveAnthropicAccountDeviceId(accountUuid: string): string {
  return createHash("sha256").update(`ocx-claude-code-device-v1:${accountUuid.trim().toLowerCase()}`, "utf8").digest("hex");
}

export function extractAnthropicCallerSessionId(body: Readonly<Rec>): string | undefined {
  if (!isRec(body.metadata) || typeof body.metadata.user_id !== "string") return undefined;
  const userId = body.metadata.user_id;
  if (Buffer.byteLength(userId) > MAX_USER_ID_BYTES) return undefined;
  try {
    const identity: unknown = JSON.parse(userId);
    if (isRec(identity) && typeof identity.session_id === "string" && identity.session_id.trim()) {
      return identity.session_id.trim();
    }
  } catch { /* ignore */ }
  return undefined;
}

/** Unknown formats stay untouched; the argument is the provider UUID, never the local pool id. */
export function bindAnthropicAccountMetadata(body: Rec, providerAccountUuid: string | undefined): Rec {
  if (!providerAccountUuid || !PROVIDER_UUID.test(providerAccountUuid) || !isRec(body.metadata)) return body;
  const userId = body.metadata.user_id;
  if (typeof userId !== "string" || Buffer.byteLength(userId) > MAX_USER_ID_BYTES) return body;
  let identity: unknown;
  try { identity = JSON.parse(userId); } catch { return body; }
  if (!isRec(identity) || typeof identity.account_uuid !== "string" || !PROVIDER_UUID.test(identity.account_uuid)) return body;
  const isolatedDeviceId = deriveAnthropicAccountDeviceId(providerAccountUuid);
  const nextDevice = typeof identity.device_id === "string" ? isolatedDeviceId : undefined;
  if (identity.account_uuid === providerAccountUuid && (nextDevice === undefined || identity.device_id === nextDevice)) return body;
  return {
    ...body,
    metadata: {
      ...body.metadata,
      user_id: JSON.stringify({
        ...identity,
        ...(nextDevice !== undefined ? { device_id: nextDevice } : {}),
        account_uuid: providerAccountUuid,
      }),
    },
  };
}
