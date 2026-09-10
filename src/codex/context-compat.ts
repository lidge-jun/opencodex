/** Backend path and opt-in config compatibility for native Codex history/notes. */
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { getCodexHome } from "./paths";

export const CONTEXT_BACKEND_PREFIX = "/backend-api/codex";

/** The single definition of the opt-in, shared by injection and the runtime gate. */
export function contextExperimentalEnabled(configContent: string): boolean {
  let parsed: { features?: { context_management?: { experimental_mode?: boolean } } };
  try {
    parsed = Bun.TOML.parse(configContent) as typeof parsed;
  } catch {
    // Injection tolerates incomplete user config; malformed TOML is not an opt-in.
    return false;
  }
  return parsed.features?.context_management?.experimental_mode === true;
}

let activation: { key: string; active: boolean } | undefined;

/**
 * Whether this proxy may serve the context relay at all, decided by opencodex reading Codex own
 * config rather than by anything a caller sends.
 *
 * Rewriting the injected base URL is what makes the feature REACHABLE, and gating only that would
 * leave the ownership registry and both endpoint prefixes live for anyone who can already reach
 * the data plane. An opt-in that a direct POST walks around is not an opt-in, so the same
 * predicate guards recording and dispatch. An absent, unreadable or malformed config is not an
 * opt-in. The result is cached against the config identity and re-read when the file changes, so
 * turning the feature off takes effect without a restart and steady-state traffic does not parse
 * TOML per request.
 */
export function contextRelayActivated(configPath?: string): boolean {
  let key: string;
  let path: string;
  try {
    // Resolved here, not in a default parameter: those are evaluated before the body, so a
    // CODEX_HOME that became unreadable while the proxy runs would throw past this try. This
    // function is now on the model path, where that would abort a turn upstream already served.
    path = configPath ?? join(getCodexHome(), "config.toml");
    const seen = statSync(path);
    key = `${path}:${seen.mtimeMs}:${seen.size}:${String(seen.ino)}`;
  } catch {
    activation = undefined;
    return false;
  }
  if (activation?.key === key) return activation.active;
  let active = false;
  try {
    active = contextExperimentalEnabled(readFileSync(path, "utf8"));
  } catch {
    // A readable stat with an unreadable body caches false under that identity, so the feature
    // stays off until the content itself changes. Fail-closed is the right direction here.
    active = false;
  }
  activation = { key, active };
  return active;
}

/** Test seam: the cache is keyed by config identity, which a temp home reuses across cases. */
export function resetContextRelayActivationForTests(): void {
  activation = undefined;
}

const CONTEXT_ENDPOINTS = new Set([
  "alpha/history/v2/list_windows", "alpha/history/v2/list_items",
  "alpha/history/v2/read_item", "alpha/history/v2/search_contents",
  "alpha/notes/v2/thread_hint", "alpha/notes/v2/list_files_by_prefix",
  "alpha/notes/v2/read_file", "alpha/notes/v2/search_contents",
  "alpha/notes/v2/append_to_file", "alpha/notes/v2/write_file",
]);

export function contextEndpoint(path: string): string | undefined {
  const endpoint = path.startsWith("/v1/") ? path.slice(4) : "";
  return CONTEXT_ENDPOINTS.has(endpoint) ? endpoint : undefined;
}

/** Alias only the data-plane prefix. Existing auth/origin and route gates still run. */
export function codexCompatibleUrl(rawUrl: string): URL {
  const url = new URL(rawUrl);
  if (url.pathname === CONTEXT_BACKEND_PREFIX || url.pathname.startsWith(CONTEXT_BACKEND_PREFIX + "/")) {
    url.pathname = "/v1" + url.pathname.slice(CONTEXT_BACKEND_PREFIX.length);
  }
  return url;
}

/** Change only marker-managed built-in routing, and only with an explicit context opt-in. */
export function contextCompatibleBaseLine(content: string, line: string): string {
  if (!contextExperimentalEnabled(content)) return line;
  const match = /^openai_base_url = "([^"]+)"$/.exec(line);
  if (!match) return line;
  const url = new URL(match[1]);
  if (url.pathname !== "/v1" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) return line;
  url.pathname = CONTEXT_BACKEND_PREFIX;
  return `openai_base_url = "${url.href}"`;
}
