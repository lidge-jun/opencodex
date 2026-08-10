# 001 — Audit response: five blockers, all accepted

The A-gate reviewer returned **FAIL** on the first roadmap. Every blocker was
independently reproduced before being accepted; none was rebutted. This document
records the synthesis, per REVIEW-SYNTHESIS-01, before the plan was re-patched.

## B1 [P0] — the inverted list does not default to sidecar-on

**Claim:** `010`'s central justification is false. A complement taken over a
static `NVIDIA_NIM_CHAT_MODELS` leaves an unclassified id in *neither* list, so
`modelInList` returns false (`src/types.ts:204`), `planVisionSidecar` returns
`undefined` (`src/vision/index.ts:235`), and the catalog advertises no image
modality (`src/codex/catalog/provider-fetch.ts:176`).

**Reproduced.** `.tmp/probe_complement.ts`, modelling the exact proposed shape:

```console
deepseek-ai/deepseek-v4-flash            sidecarWouldRun=true
moonshotai/kimi-k2.6                     sidecarWouldRun=false
brandnew/model-nobody-classified         sidecarWouldRun=false   <-- #956 persists
```

**Accepted.** I inverted which list is maintained but kept the closed world. The
failure I claimed to have fixed survives verbatim for any id NVIDIA adds after
the snapshot. This is the same lesson as the three earlier allowlist failures in
this session, and I reproduced it while writing the document that cites them.

**Root cause:** the classification field is membership-in-a-list, so any design
expressed purely as list contents inherits closed-world semantics. Escaping it
requires changing the *predicate*, not the lists.

## B2 [P0] — verified vision models stay unusable from the Codex app

**Claim:** removing a native-vision id from `noVisionModels` is not enough.
`applyProviderConfigHints` adds `image` to `inputModalities` only for
`noVisionModels` members (`provider-fetch.ts:176`), and NIM `/v1/models` carries
no modality metadata. So kimi-k2.6 et al. end up advertised text-only and the
Codex app blocks attachments before their native path can run.

**Accepted.** `010` explicitly asserted the catalog "does not fabricate" image
capability for these ids and treated that as correct. It is a second bug, not a
neutral outcome: #964 makes them lossy, my first design makes them blocked.

**Fix:** verified native-vision ids need explicit
`modelInputModalities[id] = ["text","image"]`, asserted against the emitted
catalog payload rather than against `undefined`.

## B3 [P0] — the Windows GUI updater never reaches the refresh command

**Claim:** `src/update/job.ts:775-790` sets `skipServiceInstall = true`
unconditionally when `process.platform === "win32" && OCX_SERVICE === "1"`.
Changing the argv cannot affect a command that is never spawned.

**Verified in source.** The skip's own comment states the reason: "`schtasks
/create` will UAC-fail and can race the subsequent direct start."

**Accepted, and it strengthens the change.** That skip is a workaround for
exactly the defect #970 reports. `repair` does not call `/create`
(`src/service.ts:1775-1785`), so the justification for skipping evaporates —
the skip must be narrowed to the install argv rather than left in place. Without
this, the dashboard-triggered Windows update, the most common GUI path, keeps
the bug while the CLI path gets fixed.

## B4 [P1] — the stale-marker fallback has no discriminator

**Claim:** `repairService()` throws plain `Error` for unsupported, conflict,
ownership, auth, absent-registration, asset-write, start, and health failures
alike (`src/service.ts:1755-1770`). `bin/ocx.mjs` spawns with inherited stdio and
sees only an exit status (`bin/ocx.mjs:251`), so "not installed" is
indistinguishable from any other failure.

**Accepted.** My proposed "repair, fall back to install on not-installed" was
unimplementable as written. Broadening it to "install after any repair failure"
would reintroduce the UAC path and could re-register a service the user had
deliberately uninstalled concurrently.

**Fix:** do not infer from the failure at all. Re-run a structured diagnostic
(`diagnoseService()`) after a failed repair and install only when it reports the
service genuinely absent while the managed-service marker still expresses intent.
State beats error-message parsing.

## B5 [P1] — retargeting produces no fresh CI evidence

**Claim:** `.github/workflows/ci.yml` uses default `pull_request` activity types
(`opened`/`synchronize`/`reopened`). A base edit emits `edited`, which is not
among them. So after retargeting a stacked child to `dev`, `gh pr checks` can
show green checks bound to the same head sha that were never run against the new
merge base. Material because `dev` is well ahead of the stacked heads.

**Accepted.** `030` said "re-read CI on the exact head sha", which I framed as
the rigorous option. It is necessary but not sufficient: sha identity does not
imply base identity.

**Fix:** after retargeting, merge current `dev` into the child to force a
`synchronize` event, and require a run whose base matches the retargeted PR
before merging.

## Sequencing change this forces

`030` closed #964 and #970 when stack 7 *opens*, mirroring the earlier carried
PRs. Those were closed with replacement code already on a branch. Here the
replacement does not exist yet and its design just failed audit, so closing now
would remove the contributor's live path while ours is unproven.

**Changed:** both close only after stack 7 is open **and** green. This
contradicts the sequencing written in the first draft of `030`; the earlier text
was wrong and is corrected there.

## What survived

`020`'s after-stop safety proof — that `ocx stop` never deregisters on any of the
three platforms — was independently re-derived and holds
(`src/service.ts:2204-2225`, with `uninstall`/`remove` as separate paths at
`:2610`). It remains the foundation of the #970 reconstruction.
