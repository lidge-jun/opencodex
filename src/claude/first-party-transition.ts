import type { OcxConfig } from "../types";
import {
  observeClaudeDesktopMode,
  resolveClaudeDesktopMode,
  type DesktopFirstPartyOptions,
} from "./desktop-first-party";

export interface ClaudeFirstPartyTransition {
  /** The whole `claudeCode` block the switch writes. */
  nextBlock: NonNullable<OcxConfig["claudeCode"]>;
  /** The stored CLI flag before the switch, for a conditional rollback. */
  previous: { present: boolean; value: boolean };
  /** The Desktop mode pinned by this switch when none was stored. */
  pinnedMode: "first-party" | "gateway" | undefined;
  /** An opt-out that keeps a shared env whose owner it cannot tell apart. */
  retainedAmbiguous: boolean;
}

/**
 * The persisted-config transition of `PUT /api/claude-code { cliFirstParty }`.
 *
 * One function so the switch and its preview cannot disagree about what the switch does: the
 * route runs it inside the locked persisted mutation, and the first-party preview runs it on
 * the same persisted snapshot before reconciling nothing. It reads Desktop evidence through
 * `observeClaudeDesktopMode` and never writes.
 */
export function claudeFirstPartyTransition(
  persisted: OcxConfig,
  requested: boolean,
  options: DesktopFirstPartyOptions = {},
): ClaudeFirstPartyTransition {
  const before = structuredClone(persisted);
  const previous = { present: Object.hasOwn(persisted.claudeCode ?? {}, "cliFirstParty"),
    value: persisted.claudeCode?.cliFirstParty === true };
  // Pin the mode Desktop resolves to *after* this mutation: while cliFirstParty is set the
  // shared env is suppressed as Desktop evidence, so an opt-out observed with the flag still
  // on would pin gateway and disconnect a Desktop install that predates the marker.
  const observedBefore = structuredClone(before);
  if (!requested) delete observedBefore.claudeCode?.cliFirstParty;
  const pinnedMode = persisted.claudeCode?.desktopMode === undefined
    ? resolveClaudeDesktopMode(before, observeClaudeDesktopMode(observedBefore, options)) : undefined;
  const nextBlock = { ...(persisted.claudeCode ?? {}) };
  if (requested) nextBlock.cliFirstParty = true;
  else delete nextBlock.cliFirstParty;
  if (pinnedMode) nextBlock.desktopMode = pinnedMode;
  // An opt-out that pins first-party from the shared env cannot tell whether that env was
  // Desktop's or a hand-configured CLI-only one; the env is retained (Desktop keeps its
  // route) and the caller is warned so it can pin gateway explicitly to release it.
  const retainedAmbiguous = !requested && previous.value && pinnedMode === "first-party";
  return { nextBlock, previous, pinnedMode, retainedAmbiguous };
}
