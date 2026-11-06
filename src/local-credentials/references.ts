import { join } from "node:path";
import { readBoundedRegularFileSync } from "../lib/bounded-file-read";

const OS_STORE_PREFIXES = ["keychain:", "gcp-sa:"] as const;
const decoder = new TextDecoder("utf-8", { fatal: true });

/**
 * The OS credential-store accounts a config document references: `keychain:<account>` API keys and
 * `gcp-sa:<account>` service-account JSON, as the active key or a pool entry. These accounts are
 * registered in local-credentials.json before a reference can leave the config, so a secret whose
 * deletion fails or never happens keeps counting after its config slot is gone.
 */
export function osStoreAccounts(config: unknown): string[] {
  const accounts = new Set<string>();
  const providers = config && typeof config === "object" ? (config as { providers?: unknown }).providers : undefined;
  if (!providers || typeof providers !== "object") return [];
  for (const row of Object.values(providers)) {
    if (!row || typeof row !== "object") continue;
    const provider = row as { apiKey?: unknown; apiKeyPool?: unknown };
    const pool = Array.isArray(provider.apiKeyPool) ? provider.apiKeyPool : [];
    for (const key of [provider.apiKey, ...pool.map(entry => entry && typeof entry === "object" ? (entry as { key?: unknown }).key : undefined)]) {
      if (typeof key !== "string") continue;
      for (const prefix of OS_STORE_PREFIXES) {
        const account = key.startsWith(prefix) ? key.slice(prefix.length) : "";
        if (account.trim() && account.length <= 1024) accounts.add(account);
      }
    }
  }
  return [...accounts];
}

/** The references in this home's config.json; an absent or unreadable file names none. */
export function configuredOsStoreAccounts(home: string): string[] {
  try { return osStoreAccounts(JSON.parse(decoder.decode(readBoundedRegularFileSync(join(home, "config.json"), 4 * 1024 * 1024)))); }
  catch { return []; }
}
