/**
 * Deferred V1 collaboration evidence from Codex's `<tools>` world-state fragment (#6844).
 *
 * When the model supports tool search (every OpenCodex catalog row), codex-rs registers the V1
 * collaboration tools as DEFERRED (core/src/tools/spec_plan.rs, add_collaboration_tools) under the
 * fixed namespace `multi_agent_v1` (core/src/tools/handlers/multi_agents_spec.rs). Neither the wire
 * tools nor the code-mode exec description then mention them. With the deferred_tool_world_state
 * feature on (default off upstream; Codex Desktop sessions were observed receiving it), codex-rs
 * instead tells the model which namespaces it can load, in a developer fragment
 * (core/src/context/world_state/tools.rs):
 *
 *   <tools>
 *   Deferred tool namespaces:
 *   - multi_agent_v1: Tools for spawning and managing sub-agents.
 *   </tools>
 *
 * Later turns carry only diffs ("Added deferred tool namespaces:", "Removed deferred tool
 * namespaces:", "No deferred tool namespaces remain."), so membership is replayed in input order.
 * The fragment is capped at 4 KiB: rows may be name-only, and whole rows may be replaced by
 * "... <n> additional namespaces omitted." (tools_budget.rs).
 *
 * The evidence is positive-only and conservative:
 * - only developer messages are read, each text part on its own, and only a part that is exactly
 *   one fragment after trimming; text that merely mentions the tag is ignored;
 * - a fragment that starts like one but breaks the line grammar clears what was carried, because a
 *   lost removal could have been multi_agent_v1; omitted removals clear for the same reason, and
 *   omitted rows never establish a namespace;
 * - it counts only beside a host that can load deferred tools: a genuine code-mode exec or a
 *   structured tool_search tool. A caller's own exec or a function merely named tool_search is not
 *   one.
 *
 * Capability boundary: the row proves that some deferred multi_agent_v1 tool is registered, not
 * that spawn_agent is. Upstream can split them only through an embedder-supplied ToolPolicy
 * allowlist; its one production allowlist (the guardian reviewer) admits no V1 tool at all, and
 * the V1 depth limit disables the surface as a unit, so Codex CLI and Desktop never send a
 * management-only V1 namespace. A developer item can also be impersonated by whoever writes the
 * conversation. Both cases receive advisory guidance they cannot act on; nothing is enforced here.
 */
import type { OcxMessage, OcxParsedRequest, OcxTool } from "../../types";
import type { CodeModeExecAnalysis } from "./code-mode-collab-surface";

const MULTI_AGENT_V1_NAMESPACE = "multi_agent_v1";
const OPEN_TAG = "<tools>";
const CLOSE_TAG = "</tools>";
const SNAPSHOT_HEADER = "Deferred tool namespaces:";
const ADDED_HEADER = "Added deferred tool namespaces:";
const REMOVED_HEADER = "Removed deferred tool namespaces:";
const EMPTY_STATE = "No deferred tool namespaces remain.";
// A description is opaque: upstream copies its first line verbatim, which may hold any character
// except \n, including U+2028/U+2029 that `.` would refuse.
const ROW = /^- ([^:\s]+)(?:: [\s\S]*)?$/;
const OMISSION = /^\.\.\. \d+ additional namespaces omitted\.$/;

type Fragment =
  | { kind: "malformed" }
  | { kind: "snapshot"; rows: Set<string>; empty: boolean }
  | { kind: "diff"; added: Set<string>; removed: Set<string>; removedOmitted: boolean; empty: boolean };

/** One standalone fragment, a malformed one, or nothing (text that is not a fragment). */
function parseFragment(text: string): Fragment | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith(OPEN_TAG)) return null;
  if (!trimmed.endsWith(CLOSE_TAG) || trimmed.length < OPEN_TAG.length + CLOSE_TAG.length) return { kind: "malformed" };
  const body = trimmed.slice(OPEN_TAG.length, trimmed.length - CLOSE_TAG.length);
  let group: "snapshot" | "added" | "removed" | undefined;
  // Upstream renders each group at most once, Added before Removed, and skips empty groups.
  const seen = new Set<"snapshot" | "added" | "removed">();
  let groupHasEntries = true;
  let empty = false;
  const rows = { snapshot: new Set<string>(), added: new Set<string>(), removed: new Set<string>() };
  let removedOmitted = false;
  const open = (next: "snapshot" | "added" | "removed"): boolean => {
    if (seen.has(next) || !groupHasEntries) return false;
    if (next === "added" && seen.has("removed")) return false;
    seen.add(next);
    group = next;
    groupHasEntries = false;
    return true;
  };
  for (const raw of body.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line === "") continue;
    // The empty-state notice closes the fragment; nothing may follow it.
    if (empty) return { kind: "malformed" };
    if (line === SNAPSHOT_HEADER) { if (!open("snapshot")) return { kind: "malformed" }; continue; }
    if (line === ADDED_HEADER) { if (!open("added")) return { kind: "malformed" }; continue; }
    if (line === REMOVED_HEADER) { if (!open("removed")) return { kind: "malformed" }; continue; }
    if (line === EMPTY_STATE) {
      if (!groupHasEntries) return { kind: "malformed" };
      empty = true;
      continue;
    }
    if (group === undefined) return { kind: "malformed" };
    groupHasEntries = true;
    if (OMISSION.test(line)) {
      if (group === "removed") removedOmitted = true;
      continue;
    }
    const row = ROW.exec(line);
    if (!row) return { kind: "malformed" };
    rows[group].add(row[1]!);
  }
  if (!groupHasEntries) return { kind: "malformed" };
  const sawSnapshot = seen.has("snapshot");
  const sawDiff = seen.has("added") || seen.has("removed");
  if (sawSnapshot && sawDiff) return { kind: "malformed" };
  if (sawSnapshot) return { kind: "snapshot", rows: rows.snapshot, empty };
  if (!sawDiff && !empty) return { kind: "malformed" };
  for (const name of rows.added) if (rows.removed.has(name)) return { kind: "malformed" };
  return { kind: "diff", added: rows.added, removed: rows.removed, removedOmitted, empty };
}

function developerTexts(message: OcxMessage): string[] {
  if (message.role !== "developer") return [];
  if (typeof message.content === "string") return [message.content];
  return message.content.flatMap(part => (part.type === "text" ? [part.text] : []));
}

/** Replays every fragment in input order; true when multi_agent_v1 is currently known deferred. */
function deferredNamespacesIncludeV1(messages: readonly OcxMessage[]): boolean {
  const current = new Set<string>();
  for (const message of messages) {
    for (const text of developerTexts(message)) {
      const fragment = parseFragment(text);
      if (fragment === null) continue;
      switch (fragment.kind) {
        case "malformed":
          current.clear();
          break;
        case "snapshot":
          current.clear();
          for (const name of fragment.rows) current.add(name);
          break;
        case "diff":
          if (fragment.removedOmitted) current.clear();
          for (const name of fragment.added) current.add(name);
          for (const name of fragment.removed) current.delete(name);
          break;
      }
      if (fragment.kind !== "malformed" && fragment.empty) current.clear();
    }
  }
  return current.has(MULTI_AGENT_V1_NAMESPACE);
}

function declaresStructuredToolSearch(tools: readonly OcxTool[] | undefined): boolean {
  return (tools ?? []).some(tool => !tool.namespace && tool.toolSearch === true);
}

/**
 * True when the request's own developer history says V1 collaboration tools are deferred and the
 * request comes from a host that can load deferred tools.
 */
export function deferredV1Evidence(parsed: OcxParsedRequest, codeMode: CodeModeExecAnalysis): boolean {
  if (!codeMode.genuineExec && !declaresStructuredToolSearch(parsed.context.tools)) return false;
  return deferredNamespacesIncludeV1(parsed.context.messages);
}

