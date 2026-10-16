# wp3 — sweep results

Eight read-only lanes covered every non-merge commit in `e432cf565a..c27a4831a9`. Six
returned CLEAN, one returned MINOR, and one returned BLOCKING. Every finding below was
re-derived against source by a second reviewer before it was accepted.

| Lane | Scope | Verdict |
|---|---|---|
| 1 | codex routing, combo resolve, provider quota | BLOCKING |
| 2 | responses/chat/claude-messages/bridge/vision/search | CLEAN |
| 3 | Claude inbound cache prefix | CLEAN |
| 4 | Codex inject, restore, history | CLEAN |
| 5 | OAuth, adapters, Devin CLI credentials | CLEAN |
| 6 | remote-control, update job | CLEAN |
| 7 | integrations, client export, CLI | MINOR |
| 8 | GUI catalog, Combo, Cline dialog | CLEAN |

## Release-blocking: the quota-avoid window skips the main account

#4368 (`d42a1363dc`) split a quota refusal into two durations. The cooldown still caps at
fifteen minutes, and a new `quotaAvoidUntil` records the window the refusal actually
announced, bounded at six hours. Pool candidates honour it at
`src/codex/routing.ts:1409`. The main account does not.

`isSelectableCodexPoolAccount` rejects `__main__`, so the main login reaches the
candidate list only through the re-insertion block at `src/codex/routing.ts:1414`, and
that block checks `isCodexAccountSoftAvoided` but never `isCodexQuotaAvoided`.
`getCodexQuotaHealthSnapshot` reads `cooldownUntil` alone, so once the fifteen-minute
cooldown lapses the main account is a first-class candidate again while its announced
window still has hours left.

A user with the main login plus a pool sees exactly the failure #4368 was written to
stop: pool accounts stay avoided for up to six hours, the main account returns after
fifteen minutes, and the quota strategy ranks it coolest because it ranks on a weekly bar
a burst limit never touches. A bound thread drops its affinity and is re-pinned to the
same exhausted account. With no pool the symptom is unchanged, because the last-resort
branch would hand back the only account anyway.

## Same commit, same omission, two more paths

The commit states that "an operator clearing the cooldown or naming the account overrules
it". Neither does.

`resetCodexRoutingForManualSelection` (`src/codex/routing.ts:988`) drops
`quotaAvoidUntil` from `upstreamHealth` and returns early when that map has no entry. A
reset-derived 429 writes to `quotaScopedHealth` instead and returns at
`src/codex/routing.ts:2763`, so naming the account clears nothing in the case the commit
actually introduced.

`clearCodexAccountCooldown` (`src/codex/routing.ts:1066`) destructures the cooldown and
probe-lease fields and carries `quotaAvoidUntil` through in `...rest`. Probe recovery at
`src/codex/routing.ts:863` deliberately drops it, with a comment saying that leaving it
would make the escape hatch stop escaping. The operator's escape hatch has the defect the
automatic one avoids.

An exhaustive scan found `quotaAvoidUntil` and `isCodexQuotaAvoided` used only in
`src/codex/routing.ts`, and no fourth omission.

## Non-blocking

Lane 7 found only the top-level help text advertising `(14 clients)` against a registry
of fifteen, which #4390 already corrected. The count never reaches dispatch;
`ocx export --client cline` and the dashboard switch both read the registry.

Lane 6 noted that `RemoteControlHost` defaults to the full capability set when a caller
omits `allowedCapabilities`. No runtime file imports `src/remote-control`, so nothing
reaches it; the documented `OCX_REMOTE_WORKSPACE_ENABLED` flag does not exist in `src/`
yet. That is a default to settle when the activation layer lands, not a regression here.

## What the lanes did not do

No lane executed the product. Every verdict is a source and diff reading, cross-checked
against the tests each commit shipped. Local product tests, builds, typecheck and install
were NOT RUN.
