import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { atomicWriteFile } from "../../config";
import {
  OCX_SECTION_MARKER,
  REALTIME_WS_BASE_URL_KEY,
  hasInjectedOpenaiBaseUrl,
  rootTomlString,
  stripJournaledOpenaiBaseUrl,
} from "../injected-marker";
import { HISTORY_RELABEL_STANDS_DOWN, preflightCodexHistoryInjection } from "../history-provider";
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

/**
 * Capture `[model_providers.opencodex]` verbatim so it can survive a restore that only
 * takes routing down (#4812).
 *
 * This is deliberately NOT a mirror of `removeOcxSection`'s scan. That one opens a
 * section on any line containing `OCX_SECTION_MARKER`, which is safe there only because
 * `stripInjectedOpenaiBaseUrl` has already consumed the identical marker that annotates
 * the root `openai_base_url`. Capture runs against the untouched file, so the same rule
 * would collect that marker and the routing line under it — and re-appending the result
 * would restore the exact base-url override the caller just removed.
 *
 * So the anchor is the provider header itself, via the shared `isOcxProviderHeaderLine`,
 * with an immediately preceding marker line pulled in as its comment. Sharing that
 * predicate is what keeps capture and removal from disagreeing about what our table is.
 */
export function extractOcxProviderTableBlock(content: string): string | null {
  const lines = content.split("\n");
  const collected: string[] = [];
  let capturing = false;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (isOcxProviderHeaderLine(line.trim())) {
      if (!capturing) {
        const previous = lines[index - 1];
        if (previous !== undefined && previous.includes(OCX_SECTION_MARKER)) collected.push(previous);
        capturing = true;
      }
      collected.push(line);
      continue;
    }
    if (!capturing) continue;
    // A foreign table header closes ours, exactly as in `removeOcxSection`. A later
    // `[model_providers.opencodex.*]` sub-table reopens capture on the next iteration,
    // which is why the two are separate passes over the same predicate.
    if (/^\s*\[/.test(line)) {
      capturing = false;
      continue;
    }
    collected.push(line);
  }
  if (collected.length === 0) return null;
  return collected.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

/**
 * Append a captured provider table to stripped content, as one buffer.
 *
 * Pure on purpose. Upstream resolves `model_provider` against the merged provider map and
 * fails the WHOLE config load on a miss — not the one thread — so a config carrying root
 * `model_provider = "opencodex"` without this table breaks every `codex` invocation. The
 * strip and the re-append therefore have to reach disk in a single write, which they can
 * only do if the append is a transform rather than a second file operation.
 */
export function appendOcxProviderTableBlock(content: string, block: string): string {
  if (hasOcxProviderTable(content)) return content;
  return `${content.replace(/\n+$/, "")}\n\n${block.replace(/\n+$/, "")}\n`;
}

/** Read the provider table straight off disk, before anything has transformed it. */
export function readOcxProviderTableBlock(): string | null {
  if (!existsSync(CODEX_CONFIG_PATH)) return null;
  return extractOcxProviderTableBlock(applyEol(readFileSync(CODEX_CONFIG_PATH, "utf-8"), "\n"));
}

/**
 * Re-attach a captured provider table after an exact journal restore.
 *
 * This is the one place retention needs a second write, because the journal replays whole
 * pre-injection bytes rather than transforming the current file. The intermediate state is
 * the safe one: the journal's config is the user's own, so it carries no
 * `model_provider = "opencodex"` for a missing table to strand. A crash between the two
 * writes leaves a fully native config, which is the direction this whole change is trying
 * to reach anyway.
 */
export function retainOcxProviderTableOnDisk(block: string): string[] | null {
  if (!existsSync(CODEX_CONFIG_PATH)) return null;
  const rawContent = readFileSync(CODEX_CONFIG_PATH, "utf-8");
  const eol = dominantEol(rawContent);
  const content = applyEol(rawContent, "\n");
  const next = appendOcxProviderTableBlock(content, block);
  if (next !== content) atomicWriteFile(CODEX_CONFIG_PATH, applyEol(next, eol));
  return block.replace(/\n+$/, "").split("\n");
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

/**
 * What the caller already decided about conversation history before calling.
 *
 * - `refuse-on-any` — nothing was decided, so re-derive and refuse on any refusal reason.
 *   This is the default, and it is what a direct caller gets.
 * - `stand-down-retain` — a stand-down was accepted and `[model_providers.opencodex]` must
 *   survive, because the rows this home tagged `opencodex` stay tagged and resolve only
 *   through that table. Those conversations still open; their requests fail against a
 *   stopped proxy, which is an ordinary connection error.
 * - `stand-down-remove` — a stand-down was accepted and the user explicitly asked for the
 *   table to go too, accepting that those conversations stop opening.
 *
 * One option rather than two booleans: retention and the refusal are the same decision seen
 * from two sides, and splitting them is how the explicit-removal path ended up refused by a
 * preflight its caller had already answered.
 */
export type RemoveCodexConfigHistoryDisposition =
  | "refuse-on-any"
  | "stand-down-retain"
  | "stand-down-remove";

export interface RemoveCodexConfigOptions {
  preserveProfile?: boolean;
  historyDisposition?: RemoveCodexConfigHistoryDisposition;
}

export interface RemoveCodexConfigResult {
  success: boolean;
  message: string;
  /** The exact lines left on disk when the disposition was `stand-down-retain`. */
  retainedProviderTable?: string[];
}

export function removeCodexConfig(
  options: RemoveCodexConfigOptions = {},
): RemoveCodexConfigResult {
  const historyDisposition = options.historyDisposition ?? "refuse-on-any";
  const historyError = preflightCodexHistoryInjection(false, false);
  // The preflight answers "may I rewrite conversation history?". Routing removal is a
  // different question, and treating one answer as both is what left `ocx uninstall`
  // pointing a live config at a port it had just removed (#4812). Only the stand-down
  // reason is separable; every other reason still means something is wrong with the
  // history state itself, and those keep the hard refusal even for a caller that decided.
  if (historyError && !(historyDisposition !== "refuse-on-any" && historyError === HISTORY_RELABEL_STANDS_DOWN)) {
    return { success: false, message: `Codex configuration preserved: ${historyError}. Native writer coordination is required.` };
  }
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
  // Captured from the pre-strip bytes: the strip is what removes the table, so reading it
  // afterwards would find nothing.
  const retainedBlock = historyDisposition === "stand-down-retain"
    ? extractOcxProviderTableBlock(content)
    : null;
  const finalContent = retainedBlock === null
    ? stripped.content
    : appendOcxProviderTableBlock(stripped.content, retainedBlock);
  if (had || finalContent !== content) {
    atomicWriteFile(CODEX_CONFIG_PATH, applyEol(finalContent, eol));
  }
  if (!options.preserveProfile && existsSync(CODEX_PROFILE_PATH))
    unlinkSync(CODEX_PROFILE_PATH);
  const retainedNote = retainedBlock === null
    ? ""
    : " Kept [model_providers.opencodex] so conversations already tagged opencodex still open;"
      + " remove it with 'ocx restore --remove-codex-provider-table' (those conversations stop opening).";
  const removedMessage = had
    ? `Removed opencodex routing from Codex config${options.preserveProfile ? "." : " + profile."}${retainedNote}`
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
    ...(retainedBlock === null ? {} : { retainedProviderTable: retainedBlock.replace(/\n+$/, "").split("\n") }),
  };
}
