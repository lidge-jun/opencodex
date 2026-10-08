import { createHash, createPrivateKey, createPublicKey, X509Certificate } from "node:crypto";
import { loadKeyringBinding } from "../../lib/keyring-native";
import type { LocalInterceptCa } from "./local-ca";

export const PICKER_CA_STORE_SERVICE = "opencodex.claude-desktop-picker.ca.v1";
const MAX_PAYLOAD_BYTES = 16 * 1024;
export interface PickerCaCredential {
  getPassword(): string | null;
  setPassword(value: string): void;
}
export type PickerCaStore = (service: string, account: string) => PickerCaCredential;
export interface StoredPickerCa extends LocalInterceptCa { fingerprint: string }

export function pickerCaConfigId(canonicalConfigDir: string): string {
  return createHash("sha256").update(canonicalConfigDir).digest("hex");
}

function nativeStore(service: string, account: string): PickerCaCredential {
  const { Entry } = loadKeyringBinding();
  // The shared loader is deliberately binding-agnostic; this is the sync Entry contract.
  return new Entry(service, account) as PickerCaCredential;
}

export function openPickerCaCredential(configId: string, store: PickerCaStore = nativeStore): PickerCaCredential {
  try { return store(PICKER_CA_STORE_SERVICE, configId); }
  catch { throw new Error("picker_ca_store_unavailable"); }
}

export function readPickerCaCredential(entry: PickerCaCredential): string | null {
  try {
    const value = entry.getPassword();
    if (value === null) return null;
    if (typeof value !== "string") throw new Error();
    return value;
  } catch { throw new Error("picker_ca_store_unavailable"); }
}

/** OS credential contents are an untrusted, bounded, exact-shape boundary. */
export function decodePickerCaCredential(
  raw: string, configId: string, acceptsAuthority: (pem: string) => boolean,
): StoredPickerCa {
  try {
    if (Buffer.byteLength(raw) > MAX_PAYLOAD_BYTES) throw new Error();
    const value = JSON.parse(raw);
    if (value === null || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).sort().join(",") !== "certPem,configId,fingerprint,keyPem,schema"
      || value.schema !== 1 || value.configId !== configId
      || typeof value.certPem !== "string" || typeof value.keyPem !== "string"
      || typeof value.fingerprint !== "string" || !/^[A-F0-9]{64}$/.test(value.fingerprint)) throw new Error();
    const cert = new X509Certificate(value.certPem);
    const privateKey = createPrivateKey(value.keyPem);
    const publicKey = createPublicKey(value.keyPem);
    const now = Date.now();
    if (cert.toString() !== value.certPem || !acceptsAuthority(value.certPem)
      || !cert.ca || !cert.checkPrivateKey(privateKey) || !cert.verify(publicKey)
      || privateKey.asymmetricKeyType !== "ec" || privateKey.asymmetricKeyDetails?.namedCurve !== "prime256v1"
      || privateKey.export({ type: "pkcs8", format: "pem" }) !== value.keyPem
      || !(Date.parse(cert.validFrom) <= now && now < Date.parse(cert.validTo))
      || createHash("sha256").update(cert.raw).digest("hex").toUpperCase() !== value.fingerprint) throw new Error();
    return { certPem: value.certPem, keyPem: value.keyPem, fingerprint: value.fingerprint, privateKey, publicKey };
  } catch { throw new Error("picker_ca_store_invalid"); }
}

export function writePickerCaCredential(entry: PickerCaCredential, configId: string, ca: StoredPickerCa): void {
  const raw = JSON.stringify({ schema: 1, configId, fingerprint: ca.fingerprint, certPem: ca.certPem, keyPem: ca.keyPem });
  if (Buffer.byteLength(raw) > MAX_PAYLOAD_BYTES) throw new Error("picker_ca_store_invalid");
  try { entry.setPassword(raw); }
  catch { throw new Error("picker_ca_store_unavailable"); }
  if (readPickerCaCredential(entry) !== raw) throw new Error("picker_ca_store_readback_failed");
}
