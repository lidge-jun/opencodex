/**
 * Credentials this installation is configured with, read when an upstream diagnostic is checked.
 *
 * A gateway can echo a credential it learned before this process ever sent it: an inactive pool
 * key, another provider's key, an OAuth token from an earlier session. Learning only from sends
 * would let such an echo be warned and finalized before the value is first dispatched, and a warning
 * cannot be retracted. So the request log also refuses any diagnostic that repeats a configured
 * value: every provider's apiKey and apiKeyPool keys (keychain and env references resolved), every
 * configured header value, every credential-named provider field, and every token in the OAuth
 * store. The set is rebuilt when the bytes of config.json or auth.json change, a stored keychain
 * secret is replaced in this process, or a referenced environment variable changes.
 *
 * Freshness is decided by content, never by file metadata. Every check reads both stores and
 * compares a digest of the bytes it read; the rebuild parses those same bytes. An inode/size/mtime
 * key missed a same-length rewrite inside one timestamp tick (coarse on Windows) and any writer that
 * preserves or backdates mtime, and then kept serving the previous, complete-looking view (#6923).
 * The cost is two small reads per check; checks run only for retained upstream diagnostics.
 *
 * Reads are observe-only: no hardening, backup, repair or warning. A file that exists but cannot be
 * read, parsed or recognized as the expected shape, or a keychain reference that cannot be resolved,
 * makes coverage incomplete and callers fail closed; an incomplete set is retried after a short delay
 * so a keychain that becomes available restores diagnostics. Values are held in memory only and
 * never serialized or exposed.
 *
 * Not covered: keychain secrets are cached per process (`readKeychain` in
 * src/providers/api-key-resolve.ts), so a secret replaced by another process is seen only after
 * this process re-resolves it.
 */
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "../config/paths";
import { resolveEnvValue } from "../config/proxy-env";
import { isKeychainReference, providerKeyResolutionGeneration, resolveProviderApiKeyQuietly } from "../providers/api-key-resolve";
import { credentialComponents, credentialSetMatches } from "../lib/outbound-credential-registry";
import { SENSITIVE_KEY_PATTERN } from "../lib/redact";

const CREDENTIAL_FIELD = /(?:key|token|secret|password|passwd|credential|cookie|authorization)$/i;
/** How long an incomplete set is trusted before its sources are read again. */
export const INCOMPLETE_RETRY_MS = 30_000;

export interface ConfiguredCredentials {
  readonly complete: boolean;
  matches(value: string): boolean;
}

interface Snapshot {
  /** The only object handed out: cache metadata (including env values) stays private here. */
  readonly view: ConfiguredCredentials;
  readonly signature: string;
  readonly envNames: readonly string[];
  readonly envFingerprint: string;
  readonly builtAt: number;
}

let cached: Snapshot | undefined;

/** One read of a store: its state for the signature and, for a readable file, the bytes read. */
interface StoreRead {
  /** "absent", "not-a-file", "unreadable", or "sha256:<hex>" of exactly the bytes in `text`. */
  readonly state: string;
  readonly text?: string;
}

function readStore(path: string): StoreRead {
  try {
    if (!statSync(path).isFile()) return { state: "not-a-file" };
  } catch (error) {
    // Only a store that is not there at all counts as intentionally absent.
    return { state: (error as NodeJS.ErrnoException)?.code === "ENOENT" ? "absent" : "unreadable" };
  }
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch {
    // Present a moment ago, gone or unreadable now (a replacement in progress): fail closed.
    return { state: "unreadable" };
  }
  return { state: `sha256:${createHash("sha256").update(bytes).digest("hex")}`, text: bytes.toString("utf8") };
}

function parseStore(read: StoreRead): { ok: boolean; value?: unknown } {
  if (read.state === "absent") return { ok: true };
  if (read.text === undefined) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(read.text.replace(/^\uFEFF/, "")) };
  } catch {
    return { ok: false };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function envFingerprint(names: readonly string[]): string {
  return names.map(name => process.env[name] ?? "\u0000unset").join("\u0000");
}

/** Mirrors resolveEnvValue: a braced or bare dollar reference reads the environment. */
function envReference(raw: string): string | undefined {
  if (!raw.startsWith("$")) return undefined;
  return /^\$\{(\w+)\}$/.exec(raw)?.[1] ?? raw.slice(1);
}

function build(configRead: StoreRead, authRead: StoreRead, signature: string, now: number): Snapshot {
  const values = new Set<string>();
  const envNames = new Set<string>();
  let complete = true;
  const add = (raw: string | undefined) => {
    if (raw) for (const part of credentialComponents(raw)) values.add(part);
  };
  const noteEnv = (raw: string) => {
    const name = envReference(raw);
    if (name) envNames.add(name);
  };
  const addReference = (raw: unknown) => {
    if (typeof raw !== "string" || !raw) return;
    noteEnv(raw);
    const resolved = resolveProviderApiKeyQuietly(raw);
    if (resolved === undefined && isKeychainReference(raw)) complete = false;
    add(resolved);
  };
  const isCredentialField = (field: string) => CREDENTIAL_FIELD.test(field) || SENSITIVE_KEY_PATTERN.test(field);
  const walkProvider = (node: unknown, depth: number) => {
    if (depth > 8) return;
    if (Array.isArray(node)) { for (const item of node) walkProvider(item, depth + 1); return; }
    if (!isRecord(node)) return;
    for (const [field, value] of Object.entries(node)) {
      if (field === "headers" && isRecord(value)) {
        for (const header of Object.values(value)) {
          if (typeof header !== "string") continue;
          noteEnv(header);
          add(resolveEnvValue(header) ?? header);
        }
      } else if (typeof value === "string") {
        if (isCredentialField(field)) addReference(value);
      } else {
        walkProvider(value, depth + 1);
      }
    }
  };
  const walkAuth = (node: unknown, depth: number) => {
    if (depth > 8) return;
    if (Array.isArray(node)) { for (const item of node) walkAuth(item, depth + 1); return; }
    if (!isRecord(node)) return;
    for (const [field, value] of Object.entries(node)) {
      if (typeof value === "string") {
        if (field === "access" || field === "refresh" || isCredentialField(field)) add(value);
      } else {
        walkAuth(value, depth + 1);
      }
    }
  };

  const configSig = configRead.state;
  const authSig = authRead.state;
  const config = parseStore(configRead);
  const auth = parseStore(authRead);
  if (!config.ok || !auth.ok) complete = false;
  // An existing file must have the shape its loader expects; anything else hides credentials.
  if (configSig !== "absent" && config.ok && (!isRecord(config.value)
    || (config.value.providers !== undefined && !isRecord(config.value.providers)))) complete = false;
  if (authSig !== "absent" && auth.ok && !isRecord(auth.value)) complete = false;
  if (isRecord(config.value) && isRecord(config.value.providers)) walkProvider(config.value.providers, 0);
  if (isRecord(auth.value)) walkAuth(auth.value, 0);

  const names = [...envNames].sort();
  const view: ConfiguredCredentials = Object.freeze({
    complete,
    matches: (value: string) => credentialSetMatches(values, candidate => values.has(candidate), value),
  });
  return {
    view,
    signature,
    envNames: names,
    envFingerprint: envFingerprint(names),
    builtAt: now,
  };
}

/** The configured credential set for the active config home, rebuilt when any input changes. */
export function configuredCredentials(now = Date.now()): ConfiguredCredentials {
  const dir = getConfigDir();
  const configRead = readStore(join(dir, "config.json"));
  const authRead = readStore(join(dir, "auth.json"));
  const signature = `${configRead.state}|${authRead.state}|${providerKeyResolutionGeneration()}|${dir}`;
  const stale = !cached
    || cached.signature !== signature
    || cached.envFingerprint !== envFingerprint(cached.envNames)
    || (!cached.view.complete && now - cached.builtAt >= INCOMPLETE_RETRY_MS);
  if (stale) cached = build(configRead, authRead, signature, now);
  return cached!.view;
}
