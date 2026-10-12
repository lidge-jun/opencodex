# 030 — closing F5: the Add Provider path also had to stop dropping the opt-out

`011_audit_response.md` scoped F5 out with a reason: `/api/providers` POST replaces a provider
row wholesale and already discards every unrecognized key, so it looked like a general payload
contract problem rather than this feature's problem.

That reasoning was half right and the conclusion was wrong.

## Why it could not stay deferred

Every other field this path drops fails toward something neutral — a missing `modelCosts` means
the Usage estimate falls back to registry prices, a missing `contextWindow` means the seed value
applies. Losing `oauthAccountFailover` does not fail toward neutral. Activation is now
presence-driven, so deleting an operator's `enabled: false` does not restore a default: it
**enables** rotation across their second subscription account, as a side effect of an edit that
had nothing to do with failover.

That is the same failure shape as F4 (login rebuilding the row), which was accepted as blocking.
The two paths differ only in which unrelated action triggers the loss.

## What changed

One preservation line in `src/server/management/provider-routes.ts`, next to the ones that
already exist for `apiKeyPool`, `modelCosts`, `requestPacing`, and the context-window maps. The
comment there records why absence means "not carried" rather than "deleted": `ProviderPayload`
(`gui/src/provider-payload.ts`) structurally cannot express the field, so the dashboard's
add/edit form can never send it. Deletion goes through PATCH with an explicit null, exactly as
#1409 established for context windows.

No GUI change. Widening `ProviderPayload` would be the wrong fix for the same reason it was the
wrong fix for `modelCosts`: the form has no control for this setting, so a payload member would
only give it a way to send `undefined` and re-create the problem.

## Verification

A regression next to the existing `modelCosts` overwrite test in
`tests/management-provider-validation.test.ts`, driven against a real server: create a provider
with `enabled: false`, POST an overwrite without the field, assert the opt-out survived.
Falsified by disabling the preservation branch — the test fails, 74 pass / 1 fail.
