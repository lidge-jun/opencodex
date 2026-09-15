import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { atomicWriteFile } from "../../config";
import {
  OCX_SECTION_MARKER,
  REALTIME_WS_BASE_URL_KEY,
  hasInjectedOpenaiBaseUrl,
  rootTomlString,
  stripJournaledOpenaiBaseUrl,
} from "../injected-marker";
import { preflightCodexHistoryInjection } from "../history-provider";
import {
  journaledInjectedOpenaiBaseUrl,
  journaledInjectedRealtimeWsBaseUrl,
} from "../journal";
import { CODEX_CONFIG_PATH, CODEX_PROFILE_PATH, readRootTomlString } from "../paths";
import { transformManagedSubagentDefaults } from "../subagent-defaults";
import {
  applyEol,
  dominantEol,
  removeProfileSection,
  stripInjectedOpenaiBaseUrl,
  stripOpencodexCatalogPath,
  stripRootRoutedModel,
} from "./config-toml";

/**
 * Sub-table headers like `[model_providers.opencodex.env_http_headers]` appear when a Codex app
 * config rewrite re-serializes the provider's inline `env_http_headers` table. They define the
 * same `model_providers.opencodex` provider, so cleanup must remove them too — otherwise the
 * provider survives with no `name` and Codex rejects the whole config
 * ("provider name must not be empty"). The dot terminator keeps a user's
 * `[model_providers.opencodex_backup]`-style tables out of scope.
 */
function isOcxProviderHeaderLine(trimmedLine: string): boolean {
  // Root form matched by regex, not equality: TOML v1.0 allows a trailing comment
  // (`[model_providers.opencodex] # comment`), and an exact compare would miss that form.
  // The sub-table prefix check already tolerates trailing comments by construction.
  return (
    /^\[model_providers\.opencodex\]\s*(?:#.*)?$/.test(trimmedLine) ||
    trimmedLine.startsWith("[model_providers.opencodex.")
  );
}

export function hasOcxProviderTable(content: string): boolean {
  return content
    .split("\n")
    .some((line) => isOcxProviderHeaderLine(line.trim()));
}

export function removeOcxSection(content: string): string {
  const lines = content.split("\n");
  const filtered: string[] = [];
  let inOcxSection = false;
  for (const line of lines) {
    if (
      line.includes(OCX_SECTION_MARKER) ||
      isOcxProviderHeaderLine(line.trim())
    ) {
      inOcxSection = true;
      continue;
    }
    if (inOcxSection) {
      // End the injected section at the next table header that ISN'T our own. Exact match on the
      // provider name (plus our own sub-tables) so a user's
      // "[model_providers.opencodex_backup]" (or similar) is preserved, not swallowed.
      if (/^\s*\[/.test(line) && !isOcxProviderHeaderLine(line.trim())) {
        inOcxSection = false;
        filtered.push(line);
      }
      continue;
    }
    filtered.push(line);
  }
  return (
    filtered
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trimEnd() + "\n"
  );
}

interface StripOpencodexConfigResult {
  content: string;
  managedDefaultsError: string | null;
}

/**
 * Detailed form used by the on-disk restore path. A damaged ownership marker is
 * ambiguous: keep the associated value, but return the transform error so the
 * caller cannot report a complete restore.
 */
function stripOpencodexConfigResult(
  content: string,
  journaledBaseUrl: string | null = null,
  journaledRealtimeWsBaseUrl: string | null = null,
): StripOpencodexConfigResult {
  let out = content;
  const hadRootOcxProvider =
    readRootTomlString(out, "model_provider") === "opencodex";
  // #1798: marker adjacency is FORMATTING evidence, and a Codex app rewrite keeps values
  // while dropping comments. Fall back to VALUE evidence -- the exact URL we recorded
  // writing -- so an app-rewritten config is still recognized as ours.
  const hadInjectedBaseUrl = hasInjectedOpenaiBaseUrl(out)
    || (journaledBaseUrl !== null && rootTomlString(out, "openai_base_url") === journaledBaseUrl);
  out = stripInjectedOpenaiBaseUrl(out); // before removeOcxSection — it keys on the marker line too
  out = stripJournaledOpenaiBaseUrl(out, journaledBaseUrl, journaledRealtimeWsBaseUrl);
  if (hasOcxProviderTable(out)) {
    out = removeOcxSection(out);
  }
  out = removeProfileSection(out);
  // Regex (not exact-string) removal so compact `model_provider="opencodex"` is stripped too —
  // must match the detection regex above, or a detected line could survive un-removed.
  out = out
    .split("\n")
    .filter((l) => !/^\s*model_provider\s*=\s*"opencodex"\s*$/.test(l))
    .join("\n");
  // Routed root model ids (`model = "provider/slug"`) only make sense while the proxy serves
  // them — strip on both the legacy re-tag form and the Design B injected-base-url form.
  if (hadRootOcxProvider || hadInjectedBaseUrl) out = stripRootRoutedModel(out);
  const managedDefaults = transformManagedSubagentDefaults(out, null);
  if (managedDefaults.ok) out = managedDefaults.content;
  out = stripOpencodexCatalogPath(out);
  return {
    content: out.replace(/\n{3,}/g, "\n\n").trimEnd() + "\n",
    managedDefaultsError: !managedDefaults.ok ? managedDefaults.error : null,
  };
}

/** Pure transform: strip the opencodex provider block + `model_provider = "opencodex"` lines. */
export function stripOpencodexConfig(content: string): string {
  return stripOpencodexConfigResult(content).content;
}

function hasOpencodexRouting(content: string): boolean {
  return (
    hasOcxProviderTable(content) ||
    /^\s*model_provider\s*=\s*"opencodex"/m.test(content) ||
    hasInjectedOpenaiBaseUrl(content)
  );
}

export function removeCodexConfig(
  options: { preserveProfile?: boolean } = {},
): { success: boolean; message: string } {
  const historyError = preflightCodexHistoryInjection(false, false);
  if (historyError) return { success: false, message: `Codex configuration preserved: ${historyError}. Native writer coordination is required.` };
  if (!existsSync(CODEX_CONFIG_PATH)) {
    if (!options.preserveProfile && existsSync(CODEX_PROFILE_PATH))
      unlinkSync(CODEX_PROFILE_PATH);
    return {
      success: true,
      message: `Codex config not found; no native restore was needed${options.preserveProfile ? "." : ", and the opencodex profile was removed if present."}`,
    };
  }
  const rawContent = readFileSync(CODEX_CONFIG_PATH, "utf-8");
  // Same EOL boundary as inject: strip in LF space, write back in the file's own ending.
  // The unchanged fast path compares in LF space so an untouched file is never rewritten.
  const eol = dominantEol(rawContent);
  const content = applyEol(rawContent, "\n");
  // Read the recorded injection once: the strip below consumes it, and so does the
  // ownership verdict, which must agree with what was actually removed.
  const journaledBaseUrl = journaledInjectedOpenaiBaseUrl();
  const journaledRealtimeWsBaseUrl = journaledInjectedRealtimeWsBaseUrl();
  const had = hasOpencodexRouting(content)
    || (journaledBaseUrl !== null && rootTomlString(content, "openai_base_url") === journaledBaseUrl)
    || (journaledRealtimeWsBaseUrl !== null
      && rootTomlString(content, REALTIME_WS_BASE_URL_KEY) === journaledRealtimeWsBaseUrl);
  const stripped = stripOpencodexConfigResult(content, journaledBaseUrl, journaledRealtimeWsBaseUrl);
  if (had || stripped.content !== content) {
    atomicWriteFile(CODEX_CONFIG_PATH, applyEol(stripped.content, eol));
  }
  if (!options.preserveProfile && existsSync(CODEX_PROFILE_PATH))
    unlinkSync(CODEX_PROFILE_PATH);
  const removedMessage = had
    ? `Removed opencodex routing from Codex config${options.preserveProfile ? "." : " + profile."}`
    : "opencodex not present in Codex config.";
  if (stripped.managedDefaultsError) {
    const routingMessage = had
      ? removedMessage
      : "No opencodex routing was present in Codex config.";
    return {
      success: false,
      message:
        `${routingMessage} Native Codex sub-agent defaults could not be safely removed: ${stripped.managedDefaultsError}. ` +
        "The ambiguous marker and adjacent value were preserved; inspect $CODEX_HOME/config.toml before using native Codex.",
    };
  }
  return {
    success: true,
    message: removedMessage,
  };
}
