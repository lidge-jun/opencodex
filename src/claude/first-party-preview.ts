/**
 * Dry run of the Claude Code CLI first-party switch (catch-up 010, G-002).
 *
 * `PUT /api/claude-code { cliFirstParty }` rewrites the env block of the default Claude home's
 * settings.json. This module answers which keys that switch would add, update or remove, with the
 * same inputs the switch uses: the persisted-config transition (`claudeFirstPartyTransition`),
 * the live config the route reconciles with, and the same settings inspection. It reports key
 * names and change kinds only, never a value, and it never writes, mints a proxy token or
 * creates the local CA: the token is read if it exists, and a missing one only means the apply
 * would write a new HTTPS_PROXY value.
 *
 * Read-only predictions stop where the switch does runtime work: starting the intercept,
 * creating secrets and dropping the NO_PROXY receipt can still refuse at apply time.
 * `applyChecks` names those steps so a caller does not present the preview as a guarantee.
 */
import { join } from "node:path";
import { getConfigDir } from "../config/paths";
import type { OcxConfig } from "../types";
import { claudeConfigDir } from "./auth-detect";
import { inspectDesktopFirstParty, observeClaudeDesktopMode, type DesktopFirstPartyOptions } from "./desktop-first-party";
import { firstPartyDesired } from "./first-party-settings";
import { claudeFirstPartyTransition } from "./first-party-transition";
import { claudeInterceptCaCertPath } from "./intercept/local-ca";
import { readClaudeInterceptProxyToken } from "./intercept/proxy-auth";
import { claudeInterceptEnabled } from "./intercept/runtime";
import { claudeInterceptProxyUrl, claudeSettingsFileState, isClaudeInterceptProxyUrl, MAX_STATUS_SETTINGS_BYTES, readClaudeSettingsEnv } from "./intercept/settings";
import { mergeClaudeInterceptNoProxy, noProxyMergeable, readNoProxyReceipt } from "./intercept/settings-no-proxy";

export type SettingsChangeKind = "add" | "update" | "remove";
export interface FirstPartySettingsChange {
  file: "settings.json";
  /** Dotted key inside settings.json, e.g. `env.HTTPS_PROXY`. */
  key: string;
  change: SettingsChangeKind;
}

/** Apply steps a read cannot predict; the switch can still refuse at one of them. */
export const FIRST_PARTY_APPLY_CHECKS = ["intercept_start", "secrets", "receipt"] as const;

export type FirstPartyPreviewRefusal = "intercept_disabled" | "foreign_env" | "unreadable";

export type FirstPartyPreview =
  | {
      ok: true;
      enabled: boolean;
      path: string;
      changes: FirstPartySettingsChange[];
      applyChecks: readonly (typeof FIRST_PARTY_APPLY_CHECKS)[number][];
    }
  | { ok: false; enabled: boolean; reason: FirstPartyPreviewRefusal; path: string };

export interface FirstPartyPreviewInput {
  /** The server's live config: the switch reconciles with it. */
  live: OcxConfig;
  /** The persisted config the switch's locked mutation transitions. */
  persisted: OcxConfig;
  /** The CLI first-party value the switch would be sent. */
  enabled: boolean;
  options?: DesktopFirstPartyOptions;
}

const MANAGED_KEYS = ["HTTPS_PROXY", "NODE_EXTRA_CA_CERTS"] as const;
// A receipt stores both the old and written NO_PROXY strings, plus its JSON fields.
const MAX_PREVIEW_RECEIPT_BYTES = 2 * MAX_STATUS_SETTINGS_BYTES + 1024;

function change(key: string, kind: SettingsChangeKind): FirstPartySettingsChange {
  return { file: "settings.json", key: `env.${key}`, change: kind };
}

export function previewClaudeFirstPartySettings(input: FirstPartyPreviewInput): FirstPartyPreview {
  const { live, persisted, enabled } = input;
  const options = { ...input.options, settingsReadLimit: MAX_STATUS_SETTINGS_BYTES };
  const dir = options.claudeConfigDir ?? claudeConfigDir();
  const path = join(dir, "settings.json");
  const refuse = (reason: FirstPartyPreviewRefusal): FirstPartyPreview => ({ ok: false, enabled, reason, path });
  const accept = (changes: FirstPartySettingsChange[]): FirstPartyPreview => ({
    ok: true, enabled, path, changes, applyChecks: enabled ? FIRST_PARTY_APPLY_CHECKS : [],
  });
  // A special or oversized settings.json would block or balloon the reads below.
  if (claudeSettingsFileState(dir) === "unsafe") return refuse("unreadable");

  // The switch's own pre-checks for turning CLI first-party on, in its order.
  if (enabled) {
    if (!claudeInterceptEnabled(live) || !claudeInterceptEnabled(persisted)) return refuse("intercept_disabled");
    const inspected = inspectDesktopFirstParty(live, options).settings;
    if (inspected.kind === "foreign") return refuse("foreign_env");
    if (inspected.kind === "unreadable") return refuse("unreadable");
  }

  // The route adopts the transitioned block into its live config and reconciles with that.
  const { nextBlock } = claudeFirstPartyTransition(persisted, enabled, options);
  const reconciled: OcxConfig = { ...live, claudeCode: nextBlock };
  const desired = firstPartyDesired(reconciled, observeClaudeDesktopMode(reconciled, options));

  const read = readClaudeSettingsEnv(dir, { maxBytes: MAX_STATUS_SETTINGS_BYTES });
  if (read.kind === "unreadable") return refuse("unreadable");
  const env = read.kind === "env" ? read.env : {};

  if (!desired.desktop && !desired.cli) {
    // Mirrors removeClaudeInterceptSettings: only our CA marks the block as ours.
    const ownedCa = claudeInterceptCaCertPath(options.opencodexConfigDir ?? getConfigDir());
    const ca = env.NODE_EXTRA_CA_CERTS;
    if (typeof ca !== "string" || ca.trim() !== ownedCa) return accept([]);
    const changes = [change("NODE_EXTRA_CA_CERTS", "remove")];
    if (isClaudeInterceptProxyUrl(env.HTTPS_PROXY)) changes.push(change("HTTPS_PROXY", "remove"));
    let receipt;
    try {
      receipt = readNoProxyReceipt(dir, MAX_PREVIEW_RECEIPT_BYTES);
    } catch { // no-excuse-ok: catch -- a bounded read failure leaves the restoration undetermined.
      return refuse("unreadable");
    }
    if (receipt && env.NO_PROXY === receipt.written) {
      const restored = receipt.hadKey ? receipt.previous : undefined;
      if (restored === undefined) changes.push(change("NO_PROXY", "remove"));
      else if (restored !== env.NO_PROXY) changes.push(change("NO_PROXY", "update"));
    }
    return accept(changes);
  }

  // A wanted env with the intercept ineligible is left exactly as it is.
  if (!claudeInterceptEnabled(reconciled)) return accept([]);

  // Mirrors applyClaudeInterceptSettings against the env the apply would write.
  const inspection = inspectDesktopFirstParty(reconciled, options);
  const state = inspection.settings;
  if (state.kind === "unreadable") return refuse("unreadable");
  if (state.kind === "foreign") return refuse("foreign_env");
  if (state.kind === "applied") return accept([]);
  if (!noProxyMergeable(env.NO_PROXY)) return refuse("foreign_env");
  // The expected HTTPS_PROXY carries the stored token; without one the apply mints a new token,
  // so any existing value is replaced. The token is read, never created.
  const token = readClaudeInterceptProxyToken(options.opencodexConfigDir ?? getConfigDir());
  const expected: Record<(typeof MANAGED_KEYS)[number], string | null> = {
    HTTPS_PROXY: token === null ? null : claudeInterceptProxyUrl(inspection.proxyPort, token),
    NODE_EXTRA_CA_CERTS: inspection.caCertPath,
  };
  const changes: FirstPartySettingsChange[] = [];
  for (const key of MANAGED_KEYS) {
    const current = env[key];
    if (current === undefined) { changes.push(change(key, "add")); continue; }
    if (current !== expected[key]) changes.push(change(key, "update"));
  }
  const noProxy = mergeClaudeInterceptNoProxy(env.NO_PROXY);
  if (noProxy !== null) changes.push(change("NO_PROXY", Object.hasOwn(env, "NO_PROXY") ? "update" : "add"));
  return accept(changes);
}
