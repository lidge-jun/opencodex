/**
 * Credentials this installation is configured with, read when an upstream diagnostic is checked.
 *
 * A gateway can echo a credential it learned before this process ever sent it: an inactive pool
 * key, another provider's key, an OAuth token from an earlier session. Learning only from sends
 * would let such an echo be warned and finalized before the value is first dispatched, and a warning
 * cannot be retracted. So the request log also refuses any diagnostic that repeats a configured
 * value: every provider's apiKey and apiKeyPool keys (keychain and env references resolved), every
 * configured header value, every credential-named provider field, and every token in the OAuth
 * store. The set is rebuilt when config.json or auth.json changes on disk, a stored keychain secret
 * is replaced, or a referenced environment variable changes.
 *
 * Reads are observe-only: no hardening, backup, repair or warning. A file that exists but cannot be
 * read, parsed or recognized as the expected shape, or a keychain reference that cannot be resolved,
 * makes coverage incomplete and callers fail closed; an incomplete set is retried after a short delay
 * so a keychain that becomes available restores diagnostics. Values are held in memory only and
 * never serialized or exposed.
 */
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

interface Snapshot extends ConfiguredCredentials {
  readonly signature: string;
  readonly envNames: readonly string[];
  readonly envFingerprint: string;
  readonly builtAt: number;
}

let cached: Snapshot | undefined;

function fileSignature(path: string): string {
  try {
    const stat = statSync(path);
    return stat.isFile() ? `${stat.ino}:${stat.size}:${stat.mtimeMs}` : "not-a-file";
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "ENOENT" ? "absent" : "unreadable";
  }
}

function readJson(path: string, signature: string): { ok: boolean; value?: unknown } {
  if (signature === "absent") return { ok: true };
  try {
    return { ok: true, value: JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, "")) };
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

function build(configPath: string, authPath: string, signature: string, now: number): Snapshot {
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

  const [configSig, authSig] = signature.split("|");
  const config = readJson(configPath, configSig!);
  const auth = readJson(authPath, authSig!);
  if (!config.ok || !auth.ok || configSig === "unreadable" || authSig === "unreadable") complete = false;
  // An existing file must have the shape its loader expects; anything else hides credentials.
  if (configSig !== "absent" && config.ok && (!isRecord(config.value)
    || (config.value.providers !== undefined && !isRecord(config.value.providers)))) complete = false;
  if (authSig !== "absent" && auth.ok && !isRecord(auth.value)) complete = false;
  if (isRecord(config.value) && isRecord(config.value.providers)) walkProvider(config.value.providers, 0);
  if (isRecord(auth.value)) walkAuth(auth.value, 0);

  const names = [...envNames].sort();
  return {
    signature,
    envNames: names,
    envFingerprint: envFingerprint(names),
    builtAt: now,
    complete,
    matches: value => credentialSetMatches(values, candidate => values.has(candidate), value),
  };
}

/** The configured credential set for the active config home, rebuilt when any input changes. */
export function configuredCredentials(now = Date.now()): ConfiguredCredentials {
  const dir = getConfigDir();
  const configPath = join(dir, "config.json");
  const authPath = join(dir, "auth.json");
  const signature = `${fileSignature(configPath)}|${fileSignature(authPath)}|${providerKeyResolutionGeneration()}|${dir}`;
  const stale = !cached
    || cached.signature !== signature
    || cached.envFingerprint !== envFingerprint(cached.envNames)
    || (!cached.complete && now - cached.builtAt >= INCOMPLETE_RETRY_MS);
  if (stale) cached = build(configPath, authPath, signature, now);
  return cached!;
}
