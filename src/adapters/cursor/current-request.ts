import type { OcxMessage } from "../../types";
import { debugProviderDiagnostic } from "../../lib/debug";
import { OPAQUE_COMPACTION_NOTE, SUMMARY_PREFIX } from "../../responses/compaction";

/**
 * The current user request for an external-model tool continuation.
 *
 * Host-generated context (canonical compaction summaries, opaque-compaction notes and standalone
 * ambient-browser wrappers) stays in history but is not a new user instruction. It is recognized by
 * its exact canonical shape, the same prefix rule the Codex client uses to detect a stored summary.
 */
function isAmbientBrowserContext(text: string): boolean {
  if (!/^<in-app-browser-context\s/.test(text)) return false;
  const openingEnd = text.indexOf(">");
  if (openingEnd < 0) return false;
  if (text.indexOf("</in-app-browser-context>", openingEnd + 1) !== text.length - "</in-app-browser-context>".length) return false;
  // Inspect one opening tag, not overlapping greedy scans over arbitrary user text.
  return /\ssource=(["'])ambient-ui-state\1(?=\s|>)/.test(text.slice(0, openingEnd + 1));
}

export function latestUserRequestText(
  rawMessages: readonly OcxMessage[] | undefined,
  textOf: (message: OcxMessage) => string,
): string {
  if (!Array.isArray(rawMessages) || rawMessages.length === 0) return "";
  try {
    for (let i = rawMessages.length - 1; i >= 0; i--) {
      const message = rawMessages[i];
      if (message?.role !== "user") continue;
      const text = textOf(message);
      const trimmed = text.trim();
      // Host-generated context remains in history, but is not a new user instruction.
      // Match whole canonical wrappers; a user quoting a marker must keep their scope.
      if (trimmed.startsWith(SUMMARY_PREFIX + "\n") || trimmed.startsWith(SUMMARY_PREFIX + "\r\n")
        || trimmed === OPAQUE_COMPACTION_NOTE || isAmbientBrowserContext(trimmed)) continue;
      // Blank/image-only input is still a real boundary: never revive an older goal.
      return text;
    }
    return "";
  } catch {
    debugProviderDiagnostic("cursor", "current-user-request-unreadable", {
      rawMessages: rawMessages.length,
    });
    return "";
  }
}
