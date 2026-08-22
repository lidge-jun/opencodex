# WP3 — Codex, restored as a routing state

Direction: `006_replan_semantic_restore.md`. First of the two hard phases.

## Why this one cannot use bytes

`restoreNativeCodex` touches four things — `config.toml`,
`opencodex.config.toml`, the model catalog, and resume-history tagging — plus it
DELETES its own journal on a complete restore (`src/codex/journal.ts:109-141`).

Two of those defeat a byte snapshot outright:

- **The catalog path can move.** `readCodexCatalogPath()` resolves from config,
  and restoring `config.toml` can change what it resolves to. A captured
  destination could point at the wrong legitimate file by the time restore runs
  (audit r3 #7).
- **History is a live SQLite database.** Copying it without holding its lock is
  its own hazard, and excluding it leaves restored proxy-routed config beside
  native-tagged threads — a real inconsistency, not a missing extra (audit r2 #7).

So Codex's pre-state describes the routing arrangement, and re-establishing it
runs the same code that established it.

## IN

1. `src/integrations/native/codex.ts` — NEW.
2. `tests/native-codex-toggle.test.ts` — NEW.

OUT: `src/codex/inject.ts`, `journal.ts`, `catalog/*`, `history-provider.ts` —
all delegated to, none modified. This phase adds no second implementation of
Codex config surgery; the existing one is marker-ownership-aware and a copy
would drift.

## The pre-state

```ts
export interface CodexState {
  /**
   * What opencodex's relationship to Codex was. NOT a file path and NOT bytes:
   * the whole point is that re-establishing it resolves every path fresh.
   */
  routing: "opencodex-local" | "native";
  /**
   * Which catalog opencodex had installed, by SELECTOR rather than by path
   * (audit r3 #7). Resolved under the Codex home at apply time and rejected if
   * it escapes it.
   */
  catalog: { selector: "default" | "configured"; presentBefore: boolean } | null;
  /** The provider tag resume history carried, so it can be re-synced. */
  historyProvider: string | null;
}
```

`custom-local`, `custom-remote` and `unknown` are deliberately absent. Those mean
somebody else owns the routing, which `preflight` refuses before any state is
captured — a pre-state that could describe a foreign arrangement would invite
re-establishing one.

## Apply

```ts
apply: async (state, ctx) => {
  if (state.routing === "native") {
    const result = restoreNativeCodex();
    if (!result.success) return { status: "write_failed", message: result.message };
  } else {
    const result = await injectCodexConfig(ctx.port, ctx.config);
    if (!result.success) return { status: "write_failed", message: result.message };
  }
  /*
   * History is reconciled SEMANTICALLY, in the direction the routing implies,
   * through the existing sync and its own backup manifest. We never copy the
   * live database. If this step fails the file state is already correct but the
   * thread tagging is not, which is exactly `partial` — the user needs to know
   * their resume list may disagree with their routing.
   */
  const synced = syncCodexHistoryProvider(
    state.routing === "native" ? "openai" : "opencodex", ...);
  if (!synced.ok) {
    return { status: "partial", message: synced.message,
      residual: ["Codex resume history provider tag"] };
  }
  return { status: "changed", message: ... };
},
```

## Preflight

Three gates, all before capture:

1. **Ownership** — `assertNativeTeardownOwned()` for the disable direction, same
   as Grok. A foreign-home service must not have Codex config pulled from under
   it (audit r1 #5).
2. **Foreign provider** — `currentExternalCodexModelProvider()` non-null refuses
   `foreign_owner`. `restoreNativeCodex` itself would return *success* with a
   "preserved" message here, which is right for a CLI and wrong for a switch: the
   user asked to turn something off and must hear that we did not.
3. **Foreign routing kind** — `custom-local`, `custom-remote` or `unknown`
   refuses `foreign_owner` too. There is no such refusal in the current code
   (`001` §Codex, confirmed by research) — health diagnostics even recommend
   `ocx restore` for those kinds. That is defensible for a CLI a human typed;
   it is not defensible for a GUI switch labelled "Codex 연동", which does not
   promise to touch a gateway the user configured themselves.

That third gate is new behavior, not a port. Recorded as such.

## Drift

Per field, never a file hash: `getCodexRoutingKind()` compared to
`state.routing`, and catalog presence compared to `state.catalog.presentBefore`.

A user who ran `ocx restore` in a terminal after disabling from the GUI has
drifted the routing without touching a byte we would recognize. The field
comparison sees it; a config fingerprint would have reported drift for an
unrelated edit and missed this one.

## What undo does NOT cover

Stated here and in the dialog copy, because the alternative is a promise we
cannot keep:

- A running Codex app-server may hold its catalog in memory
  (`app-server-processes.ts:546`) and nothing proves it re-reads
  `openai_base_url`. A new `codex` process picks up the change; an open session
  may not.
- The history re-sync restores the provider TAG. It does not reconstruct rows
  the user deleted in between.

## Acceptance

- [ ] Disable with `routingKind === "opencodex-local"` restores native routing;
      a fresh `getCodexRoutingKind()` reads `native`.
- [ ] Enable re-injects and the kind reads `opencodex-local`.
- [ ] `custom-local`, `custom-remote` and `unknown` all refuse `foreign_owner`
      and write nothing.
- [ ] An active external `model_provider` refuses `foreign_owner` — NOT a
      success with a "preserved" message.
- [ ] A foreign-home install-state fixture refuses `home_mismatch`.
- [ ] The catalog selector resolves under the Codex home; a selector resolving
      outside it is refused rather than written (audit r3 #7).
- [ ] A failed history sync yields `partial` naming the history tag, with the
      file state already correct.
- [ ] Undo re-applies the captured routing through the same functions; no path
      is read from stored state.
- [ ] Drift is per field and detects a terminal `ocx restore` between capture
      and undo.
- [ ] `bun run typecheck` and the existing Codex tests green.
