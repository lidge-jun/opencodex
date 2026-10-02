/** Serving-account alignment for observed JSON-string Claude metadata. No body-wide matching. */
const PROVIDER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_USER_ID_BYTES = 4096;
type Rec = Record<string, unknown>;
const isRec = (value: unknown): value is Rec => value !== null && typeof value === "object" && !Array.isArray(value);

/** Unknown formats stay untouched; the argument is the provider UUID, never the local pool id. */
export function bindAnthropicAccountMetadata(body: Rec, providerAccountUuid: string | undefined): Rec {
  if (!providerAccountUuid || !PROVIDER_UUID.test(providerAccountUuid) || !isRec(body.metadata)) return body;
  const userId = body.metadata.user_id;
  if (typeof userId !== "string" || Buffer.byteLength(userId) > MAX_USER_ID_BYTES) return body;
  let identity: unknown;
  try { identity = JSON.parse(userId); } catch { return body; }
  if (!isRec(identity) || typeof identity.account_uuid !== "string" || !PROVIDER_UUID.test(identity.account_uuid)
    || identity.account_uuid === providerAccountUuid) return body;
  return { ...body, metadata: { ...body.metadata, user_id: JSON.stringify({ ...identity, account_uuid: providerAccountUuid }) } };
}
