/**
 * Credentials this installation is configured with, read when an upstream diagnostic is checked.
 *
 * A gateway can echo a credential it learned before this process ever sent it: an inactive pool
 * key, another provider's key, an OAuth token from an earlier session. Learning only from sends
 * would let such an echo be warned and finalized before the value is first dispatched, and a warning
 * cannot be retracted. So the request log also refuses any diagnostic that repeats a configured
 * value: every provider's apiKey and apiKeyPool keys (keychain and env references resolved), every
 * configured header value, every credential-named provider field, and every token in the OAuth
 * store. The set is rebuilt only when config.json or auth.json changes on disk, or a stored
 * keychain secret is replaced.
 *
 * Reads are observe-only: no hardening, backup or repair. A file that exists but cannot be read or
 * parsed, or a keychain reference that cannot be resolved, makes coverage incomplete, and callers
 * then fail closed. Values are held in memory only and never serialized or exposed.
 */
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "../config/paths";
import { resolveEnvValue } from "../config/proxy-env";
import { isKeychainReference, providerKeyResolutionGeneration, resolveProviderApiKey } from "../providers/api-key-resolve";
import { credentialComponents, credentialSetMatches, isCredentialName } from "../lib/outbound-credential-registry";

const CONFIG_CREDENTIAL_FIELD = /(?:key|token|secret|password|passwd|credential|cookie|authorization)$/i;

export interface ConfiguredCredentials {
  readonly complete: boolean;
  matches(value: string): boolean;
}

interface Snapshot extends ConfiguredCredentials { readonly signature: string }

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
    return { ok: true, value: JSON.parse(readFileSync(path, "utf8").replace(/^﻿/, "")) };
  } catch {
    return { ok: false };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function build(configPath: string, authPath: string, signature: string): Snapshot {
  const values = new Set<string>();
  let complete = true;
  const add = (raw: string | undefined) => {
    if (raw) for (const part of credentialComponents(raw)) values.add(part);
  };
  const addReference = (raw: unknown) => {
    if (typeof raw !== "string" || !raw) return;
    const resolved = resolveProviderApiKey(raw);
    if (resolved === undefined && isKeychainReference(raw)) complete = false;
    add(resolved);
  };
  const walkProvider = (node: unknown, depth: number) => {
    if (depth > 8) return;
    if (Array.isArray(node)) { for (const item of node) walkProvider(item, depth + 1); return; }
    if (!isRecord(node)) return;
    for (const [field, value] of Object.entries(node)) {
      if (field === "headers" && isRecord(value)) {
        for (const header of Object.values(value)) if (typeof header === "string") add(resolveEnvValue(header) ?? header);
      } else if (typeof value === "string") {
        if (CONFIG_CREDENTIAL_FIELD.test(field) || isCredentialName(field)) addReference(value);
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
        if (field === "access" || field === "refresh" || CONFIG_CREDENTIAL_FIELD.test(field) || isCredentialName(field)) add(value);
      } else {
        walkAuth(value, depth + 1);
      }
    }
  };

  const [configSig, authSig] = signature.split("|");
  const config = readJson(configPath, configSig!);
  const auth = readJson(authPath, authSig!);
  if (!config.ok || !auth.ok || configSig === "unreadable" || authSig === "unreadable") complete = false;
  if (isRecord(config.value) && isRecord(config.value.providers)) walkProvider(config.value.providers, 0);
  walkAuth(auth.value, 0);

  return {
    signature,
    complete,
    matches: value => credentialSetMatches(values, candidate => values.has(candidate), value),
  };
}

/** The configured credential set for the active config home, rebuilt when either file changes. */
export function configuredCredentials(): ConfiguredCredentials {
  const dir = getConfigDir();
  const configPath = join(dir, "config.json");
  const authPath = join(dir, "auth.json");
  const signature = `${fileSignature(configPath)}|${fileSignature(authPath)}|${providerKeyResolutionGeneration()}|${dir}`;
  if (cached?.signature !== signature) cached = build(configPath, authPath, signature);
  return cached;
}
