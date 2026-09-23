import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { atomicWriteFile } from "../../config";
import {
  REALTIME_WS_BASE_URL_KEY,
  hasInjectedOpenaiBaseUrl,
  rootTomlString,
  stripJournaledOpenaiBaseUrl,
} from "../injected-marker";
import { HISTORY_RELABEL_STANDS_DOWN, preflightCodexHistoryInjection } from "../history-provider";
import {
  journaledInjectedOpenaiBaseUrl,
  journaledInjectedRealtimeWsBaseUrl,
  journaledInjectedRootWebSearch,
  journaledReplacedRootWebSearch,
} from "../journal";
import { CODEX_CONFIG_PATH, CODEX_PROFILE_PATH, readRootTomlString } from "../paths";
import { transformManagedSubagentDefaults } from "../subagent-defaults";
import {
  applyEol,
  dominantEol,
  ensureRootWebSearchDisabled,
  removeProfileSection,
  stripInjectedOpenaiBaseUrl,
  stripOpencodexCatalogPath,
  stripRootRoutedModel,
} from "./config-toml";

import { appendOcxProviderTableBlock, extractOcxProviderTableBlock, hasOcxProviderTable, removeOcxSection } from "./provider-table";
export { appendOcxProviderTableBlock, extractOcxProviderTableBlock, hasOcxProviderTable, removeOcxSection } from "./provider-table";

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
  journaledRootWebSearch: string | null = null,
  journaledReplacedWebSearch: string | null = null,
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
  // The enabled direction of the web-search transform is also the purge: it drops our pair, drops a
  // marker-less `disabled` the journal proves we wrote, and puts back the operator line we had to
  // remove for as long as the switch was off. Nothing of ours is written here.
  out = ensureRootWebSearchDisabled(out, false, {
    injectedValue: journaledRootWebSearch,
    replacedUserLine: journaledReplacedWebSearch,
  }).content;
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
  const journaledRootWebSearch = journaledInjectedRootWebSearch();
  const journaledReplaced = journaledReplacedRootWebSearch();
  const had = hasOpencodexRouting(content)
    || (journaledBaseUrl !== null && rootTomlString(content, "openai_base_url") === journaledBaseUrl)
    || (journaledRealtimeWsBaseUrl !== null
      && rootTomlString(content, REALTIME_WS_BASE_URL_KEY) === journaledRealtimeWsBaseUrl);
  const stripped = stripOpencodexConfigResult(
    content,
    journaledBaseUrl,
    journaledRealtimeWsBaseUrl,
    journaledRootWebSearch,
    journaledReplaced,
  );
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
