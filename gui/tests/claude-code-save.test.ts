import { expect, test } from "bun:test";
import {
  acknowledgeSave,
  applyServerRead,
  claudeCodeSaveBody,
  isClaudeCodeDraftDirty,
  mergeServerRead,
  normalizedModelMap,
  revertEditable,
  type ClaudeCodeEditable,
} from "../src/pages/claude-code-save";
import type { ClaudeCodeState, MapRow } from "../src/pages/claude-code-types";

const STATE = {
  enabled: true,
  cliFirstParty: false,
  cliFirstPartyApplied: false,
  desktopFirstParty: false,
  interceptRunning: true,
  interceptEligible: true,
  sharedProxy: "none",
  authMode: "auto",
  autoConnectSupported: true,
  systemEnv: false,
  fastMode: null,
  maxContextTokens: null,
  autoContext: true,
  autoCompactWindow: null,
  injectAgents: true,
  smallFastModel: "",
  effectiveModelEnv: {},
  available: ["a/model"],
  aliases: [],
  port: 10100,
} satisfies ClaudeCodeState;

const row = (from: string, to: string, id = `${from}->${to}`): MapRow => ({ id, from, to });
const editable = (state: Partial<ClaudeCodeState> = {}, rows: MapRow[] = []): ClaudeCodeEditable => ({ state: { ...STATE, ...state }, rows });

test("the Save body never carries the immediate connection switch", () => {
  expect("enabled" in claudeCodeSaveBody(STATE, [])).toBe(false);
});

test("Save preserves unset helper identity and explicit deletion without materializing A", () => {
  const body = claudeCodeSaveBody({ ...STATE,
    webSearchSidecar: { backend: "anthropic", model: "claude-haiku-4-5" },
    visionSidecar: { backend: "anthropic", model: "claude-haiku-4-5", anthropicInstance: "anthropic2" },
  }, []);
  expect(body.webSearchSidecar).toEqual({ backend: "anthropic", model: "claude-haiku-4-5" });
  expect(body.visionSidecar?.anthropicInstance).toBe("anthropic2");
  expect(claudeCodeSaveBody({ ...STATE, visionSidecar: { backend: "openai", anthropicInstance: null } }, []).visionSidecar)
    .toEqual({ backend: "openai", model: "", anthropicInstance: null });
});

test("modelMap is trimmed, drops blank rows, keeps the last duplicate and sorts keys", () => {
  expect(normalizedModelMap([row(" b ", " x "), row("", "y"), row("a", ""), row("b", "z"), row("a", "w")]))
    .toEqual({ a: "w", b: "z" });
  expect(Object.keys(normalizedModelMap([row("z", "1"), row("a", "2")]))).toEqual(["a", "z"]);
});

test("dirty ignores row ids and live fields but counts blank rows", () => {
  const base = editable({}, [row("a", "b", "1")]);
  expect(isClaudeCodeDraftDirty(editable({}, [row("a", "b", "2")]), base)).toBe(false);
  expect(isClaudeCodeDraftDirty(editable({ enabled: false, aliases: [{ id: "x", display_name: "x" }] }, [row("a", "b")]), base)).toBe(false);
  expect(isClaudeCodeDraftDirty(editable({}, [row("a", "b"), row("", "")]), base)).toBe(true);
  expect(isClaudeCodeDraftDirty(editable({ authMode: "proxy" }, [row("a", "b")]), base)).toBe(true);
});

test("a read refreshes server fields of a dirty draft and keeps its edits", () => {
  const baseline = editable();
  const draft = editable({ authMode: "proxy" }, [row("x", "y")]);
  const next = editable({ enabled: false, available: ["new/model"] });
  const merged = applyServerRead({ draft, baseline, adoptNextRead: false }, next);
  expect(merged.draft.state.authMode).toBe("proxy");
  expect(merged.draft.state.enabled).toBe(false);
  expect(merged.draft.state.available).toEqual(["new/model"]);
  expect(merged.draft.rows).toEqual([row("x", "y")]);
  expect(merged.baseline).toBe(next);
});

test("a clean draft, or a Save acknowledgement, adopts the server copy outright", () => {
  const next = editable({}, [row("a", "b")]);
  const clean = applyServerRead({ draft: editable(), baseline: editable(), adoptNextRead: false }, next);
  expect(clean.draft).toBe(next);
  // Saved untrimmed text: the server normalizes it, and the acknowledgement must settle it.
  const acked = applyServerRead({ draft: editable({}, [row(" a ", "b"), row("", "")]), baseline: editable(), adoptNextRead: true }, next);
  expect(acked.draft).toBe(next);
  expect(isClaudeCodeDraftDirty(acked.draft, acked.baseline)).toBe(false);
});

test("merge and revert move exactly the editable fields", () => {
  const draft = { ...STATE, authMode: "proxy" as const, enabled: false };
  expect(mergeServerRead(draft, { ...STATE, enabled: true }).authMode).toBe("proxy");
  const reverted = revertEditable(draft, STATE);
  expect(reverted.authMode).toBe("auto");
  expect(reverted.enabled).toBe(false);
});

test("an edit back to the old value during Save survives the acknowledging read", () => {
  const old = editable({ authMode: "proxy" });
  const submitted = editable({ authMode: "auto" });
  // Saved auto, then switched back to proxy while the PUT was in flight.
  const acked = acknowledgeSave({ draft: editable({ authMode: "proxy" }), baseline: old, adoptNextRead: false }, submitted)!;
  expect(acked.adoptNextRead).toBe(false);
  expect(isClaudeCodeDraftDirty(acked.draft, acked.baseline)).toBe(true);
  const read = applyServerRead(acked, editable({ authMode: "auto" }));
  expect(read.draft.state.authMode).toBe("proxy");
});

test("after a successful Save, Revert restores the saved values", () => {
  const submitted = editable({ authMode: "auto" });
  const acked = acknowledgeSave({ draft: submitted, baseline: editable({ authMode: "proxy" }), adoptNextRead: false }, submitted)!;
  expect(acked.adoptNextRead).toBe(true);
  expect(isClaudeCodeDraftDirty(acked.draft, acked.baseline)).toBe(false);
  expect(revertEditable(editable({ authMode: "subscription" }).state, acked.baseline.state).authMode).toBe("auto");
});

test("a successful Save shows the normalized rows even if the refresh never lands", () => {
  const submitted = editable({}, [row(" a ", " b "), row("", ""), row("c", "d"), row("c", "e")]);
  const acked = acknowledgeSave({ draft: submitted, baseline: editable(), adoptNextRead: false }, submitted)!;
  expect(acked.draft.rows.map(r => [r.from, r.to])).toEqual([["a", "b"], ["c", "e"]]);
  expect(acked.baseline.rows.map(r => [r.from, r.to])).toEqual([["a", "b"], ["c", "e"]]);
  expect(isClaudeCodeDraftDirty(acked.draft, acked.baseline)).toBe(false);
  // An edit made while the PUT was in flight stays on screen and stays dirty.
  const edited = editable({}, [row(" a ", " b "), row("x", "y")]);
  const kept = acknowledgeSave({ draft: edited, baseline: editable(), adoptNextRead: false }, submitted)!;
  expect(kept.draft).toBe(edited);
  expect(isClaudeCodeDraftDirty(kept.draft, kept.baseline)).toBe(true);
});
