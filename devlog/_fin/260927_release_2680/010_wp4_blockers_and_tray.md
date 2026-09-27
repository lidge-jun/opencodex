# 010 — wp4: release blockers and Windows tray parity

## Fixes (one PR to dev)

| Finding | Files | Change | Proof |
|---|---|---|---|
| Kiro discovery failure without a last good list retried on every request | `src/providers/kiro-model-catalog.ts` | `failedUntil` map carries the 60 s retry per account identity; cleared on success and by `clearKiroAccountModels` | new case in `tests/providers/kiro/kiro-model-catalog.test.ts` fails before (2 calls), passes after (1) |
| Native tray `switchFailed` cached and settling later switches | `desktop/src-tauri/src/native_tray.rs` | `cached()` drops the one-shot flag from the snapshot every refresh starts from | `cargo test --lib native_tray` |
| Home-initiated Child relays answer 503 | `src/client/link-relay.ts`, `src/client/runtime.ts` | explicit `HOME_INITIATED_LINK_TUNNEL` gate for a link-mode runtime without a sidecar; a relay with no gate still refuses | new case in `tests/clients/client-link-relay.test.ts`; the lane's repro passes |
| Devin preflight test leaks its adapter mock | `tests/responses/responses-grok-devin-preflight.test.ts` | restore the module in `afterAll` | 3-file run 82 pass (was 55/27) |

## Windows/Linux tray parity (web tray `gui/src/pages/Tray.tsx`)

| macOS patch | Web tray before | Change |
|---|---|---|
| #5920 windows that report data | present | none |
| #5922 provider marks, severity bars | missing | `ProviderIcon` in headings; `quotaSeverity` classes on bars (70/90) |
| #5931 switch the active account | missing | `switchState`/`exhausted` in `parseAccounts`, `accountSwitchRequest` routes, "Use this account" on hover/focus, pending and failure states |
| #5921 widget reload | not applicable (macOS widget) | none |

The popup sends the switch with the dashboard session (`window.fetch` is session-wrapped by
`gui/src/api.ts`), not the desktop capability the native panel uses.

## Verification

`bun run typecheck`, GUI `tsc` and lint, `bun run structure:check`, `bun run privacy:scan`, the focused
test files above, `gui/tests/tray-data.test.ts`, and a Playwright capture of the web tray against the
running proxy. Full suite: PR CI.

## Audit round 1 (Carver, astra) — FAIL, dispositions

1. GUI build: `providerSources` `flatMap` inferred only `'codex'` — folded (`flatMap<TrayProviderSource>`; `tsc -p tsconfig.app.json` exit 0).
2. A Child-initiated link whose sidecar was deleted took the Home-initiated gate — folded. A join now
   writes `link/child-initiated.json` with the link id; the runtime uses the Home gate only when neither
   the sidecar nor a matching marker exists, and an unreadable marker counts as present. The auditor's
   repro now answers 503 with no send for deleted and corrupt sidecars and for hub transport.
   Residual: a 2.67.0 join made before this marker existed, with its sidecar later deleted, is treated as
   Home-initiated, which is the 2.67.0 behaviour for every link.
3. Switch settled before the reload — folded: the row stays pending until the reload the switch started completes.
4. Unbounded PUT — folded: `createBoundedFetch(20 s)`; a timeout reports the switch failure.
Note (not folded): the web tray does not print `blockedReason`; a blocked account simply offers no "Use".
5. Round 2: pre-marker joins — partly folded. The runtime records the marker at start whenever the
   sidecar is intact (`recordChildInitiatedLink`), so a pre-marker join that starts once on 2.68.0 is
   protected from then on. Rebutted for the remaining case, a pre-marker join whose sidecar was deleted
   before its first 2.68.0 start: that state is indistinguishable from a 2.67.0 Home-initiated link, and
   failing it closed would break every existing Home-initiated link, which the owner chose to keep working.
   It keeps exactly the 2.67.0 behaviour, the owner-accepted baseline.
