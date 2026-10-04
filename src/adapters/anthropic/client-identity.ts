/** Request-local compatibility data. Client headers never grant authorization or credential authority. */
import { DESKTOP_ENTRYPOINTS, interceptEntrypoint } from "../../claude/intercept/client-class";

const MAX_IDENTITY_BYTES = 4096;
const MAX_VALUE_BYTES = 512;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SDK_TOKEN = /^[A-Za-z0-9._+-]{1,128}$/;
const NAMES = [
  "User-Agent", "X-App", "X-Claude-Code-Session-Id", "x-client-request-id",
  "X-Stainless-Lang", "X-Stainless-Runtime", "X-Stainless-Runtime-Version",
  "X-Stainless-Package-Version", "X-Stainless-OS", "X-Stainless-Arch",
  "X-Stainless-Retry-Count", "X-Stainless-Timeout",
] as const;
const REQUIRED = ["User-Agent", "X-App", "X-Claude-Code-Session-Id", "X-Stainless-Lang", "X-Stainless-Runtime"] as const;
declare const identityBrand: unique symbol;
/** Opaque in-memory handle: serializing it cannot publish caller headers. */
export interface AnthropicClientIdentity { readonly [identityBrand]: true }
const bundles = new WeakMap<AnthropicClientIdentity, Readonly<Record<string, string>>>();

function valid(name: typeof NAMES[number], value: string): boolean {
  if (!value || Buffer.byteLength(value) > MAX_VALUE_BYTES || /[^\x20-\x7e]/.test(value)) return false;
  if (name === "User-Agent") {
    const entrypoint = interceptEntrypoint(value);
    return entrypoint === "cli" || entrypoint === "sdk-cli" || entrypoint === "sdk"
      || (DESKTOP_ENTRYPOINTS as readonly string[]).includes(entrypoint ?? "");
  }
  if (name === "X-App") return value === "cli";
  if (name === "X-Claude-Code-Session-Id" || name === "x-client-request-id") return UUID.test(value);
  if (name === "X-Stainless-Lang") return value === "js";
  if (name === "X-Stainless-Runtime") return value === "node";
  if (name === "X-Stainless-Retry-Count" || name === "X-Stainless-Timeout") return /^\d{1,6}$/.test(value);
  return SDK_TOKEN.test(value);
}

/** Select only a coherent observed CLI/SDK/Desktop Code bundle; a UA alone cannot select this lane. */
export function captureAnthropicClientIdentity(headers: Headers): AnthropicClientIdentity | undefined {
  const connection = headers.get("connection") ?? "";
  if (Buffer.byteLength(connection) > MAX_VALUE_BYTES) return undefined;
  const hopNames = new Set(connection.toLowerCase().split(",").map(name => name.trim()));
  const selected: Record<string, string> = {};
  let bytes = 0;
  for (const name of NAMES) {
    const value = headers.get(name);
    if (value === null) continue;
    // Headers joins duplicate occurrences. Every scalar validator rejects joined values;
    // the anchored Claude UA parser also rejects a second appended user agent.
    if (hopNames.has(name.toLowerCase()) || !valid(name, value)) {
      if ((REQUIRED as readonly string[]).includes(name)) return undefined;
      continue;
    }
    bytes += Buffer.byteLength(name) + Buffer.byteLength(value);
    if (bytes > MAX_IDENTITY_BYTES) return undefined;
    selected[name] = value;
  }
  if (REQUIRED.some(name => selected[name] === undefined)) return undefined;
  const handle = Object.freeze({}) as AnthropicClientIdentity;
  bundles.set(handle, Object.freeze(selected));
  return handle;
}

/** A locally captured coherent compatibility bundle; neither provenance nor authorization. */
export function hasObservedAnthropicClientIdentity(identity: AnthropicClientIdentity | undefined): boolean {
  return identity !== undefined && bundles.has(identity);
}

/** Called only after the builder verifies a first-party destination. Unknown/forged handles do nothing. */
export function applyAnthropicClientIdentity(headers: Record<string, string>, identity: AnthropicClientIdentity | undefined, operatorHeaders?: Readonly<Record<string, string>>): void {
  const values = identity && bundles.get(identity);
  if (!values) return;
  const configured = new Set(Object.keys(operatorHeaders ?? {}).map(name => name.toLowerCase()));
  for (const [name, value] of Object.entries(values)) {
    if (configured.has(name.toLowerCase())) continue;
    for (const existing of Object.keys(headers)) {
      if (existing.toLowerCase() === name.toLowerCase()) delete headers[existing];
    }
    headers[name] = value;
  }
}
