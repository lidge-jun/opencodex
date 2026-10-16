# Release train 5 — account-pool lane roadmap

Lane `rt5-account-pool`, base `origin/dev` at `eb7f0f0970`. The coordinator
merges; this lane opens one independent PR per item against `dev`.

| Order | Item | Decade doc | Branch |
|---|---|---|---|
| 1 | #6154 pace Codex quota recovery queries (fixes #6153) | 010_quota_query_backoff_6154.md | codex/rt5-account-pool-quota-backoff |
| 2 | #5831 recover stale main locks from two-window WHAM usage | 020_main_lock_two_window_5831.md | codex/rt5-account-pool-main-lock |
| 3 | #5099 remaining Antigravity 401/403 failover and health | 050_antigravity_failover_health_5099.md | codex/rt5-account-pool-antigravity |
| 4 | #5561 model-aware Anthropic OAuth pool routing | 040_anthropic_model_routing_5561.md | codex/rt5-account-pool-anthropic-routes |
| 5 | #5956 low-quota protection policy (fixes #5649) | 030_low_quota_protection_5956.md | codex/rt5-account-pool-low-quota |

Order follows dependency and provider impact: the two Codex main-account quota
fixes share `src/codex/auth-api/main-account-probe.ts`, so #6154 lands first and
#5831 rebases on it. The Antigravity and Anthropic items touch disjoint provider
paths. #5956 adds a new policy on top of the quota evidence the first two items
change, so it comes last.

Each decade doc records the carry/reimplement/drop decision, the file change
map, ratchet and test-layout obligations, tests, and docs. Terminal outcomes and
PR links are recorded in `090_closeout.md`.

## Main dispositions (P, 2026-09-28)

- 010 (#6154): accepted as written, including blocker 3's recommendation that an
  unusable HTTP 200 body counts as a failed usage read and keeps pacing.
- 020 (#5831): accepted. The PR opens as a **draft** carrying the three
  contributor commits; the provider window-topology confirmation stays a
  maintainer decision and is stated in the PR body. It is based on `dev`
  independently of #6154; before push the lane verifies the union with the
  #6154 branch (merge-tree plus the shared recovery test) and rebases after
  whichever merges first.
- 030 (#5956): accepted. The alert is a bounded backend ledger, a log line and an
  authenticated read API; no OS popup ships, so the PR says "Refs #5649" and does
  not close it.
- 040 (#5561): accepted, including the `ocx account routes anthropic` verb.
- 050 (#5099): amended. The slice avoids `gui/`. It reuses no misleading
  recovery kind; a new `oauth-account-403` kind (with its Logs label in all ten
  locales) is added only if an existing invariant test requires every rotation to
  carry a recovery kind, and then the PR includes the required screenshot. The
  persistent health store and probes are deferred with the reason recorded in 050.

## Audit fold-back (A round 1, reviewer verdict GO-WITH-FIXES, blockers=3)

1. **050 one-sibling guard (High, folded).** `antigravity401RotationAttempted` is
   set only by the 401 paths, so a 403 chain across three accounts could rotate
   up to the generic failover limit. The slice adds one per-request
   auth-refusal attempt flag shared by the 401 and 403 sibling paths, set before
   the 403 rotation. Tests cover a three-account 403 chain (exactly one extra
   send) and a 401-then-403 sequence (no second sibling).
2. **050 recovery kind (High, folded; supersedes the conditional disposition
   above).** The resend helper requires a recovery kind, and reusing
   `oauth-401` would mislabel the attempt. The slice adds `oauth-account-403`
   to `ATTEMPT_RECOVERY_KIND_ROSTER`, maps it in `gui/src/pages/Logs.tsx`, and
   labels it in all ten locale catalogs. This is the one `gui/` change the lane
   makes, and it is strictly required by the telemetry contract. The PR
   description carries a screenshot hosted on a non-PR `codex/rt5-*` asset ref,
   linked by commit SHA and never committed to the PR branch.
3. **030 shutdown flush (Medium, folded).** Resource-owner cleanup is synchronous
   and `release()` runs it immediately. The low-quota writer therefore exposes
   an async, time-bounded `flush()` that the server stop path awaits **before**
   releasing its lifecycle owner. A failed or timed-out flush logs a warning and
   records a failed event; it does not block shutdown. A test stops the first of
   two live servers while its save is pending and checks that the other server's
   registration survives.

## Audit fold-back (A round 2, GO-WITH-FIXES, blockers=2)

1. **Screenshot ref (Medium, rebutted with a bounded alternative).** AGENTS.md
   names `pr-assets` for maintainer command-line uploads, but this lane's push
   authority is limited to its own `codex/rt5-*` branches. The purpose of the
   rule is to keep the image off the PR branch so the squash never carries it
   into `dev`. An asset-only `codex/rt5-account-pool-assets` branch, which is
   never a PR head, satisfies that purpose within lane authority. The PR body
   links the image by commit SHA and asks the coordinator to re-host it on
   `pr-assets` if preferred.
2. **Late write after release (Medium, folded).** Each low-quota writer carries
   an owner generation. `flush()` or release marks the owner closed. A queued or
   retrying save checks the generation before it starts the config write and
   drops its work, recording a `cancelled` event, once the owner is closed. A
   test times out a flush, releases the owner, then advances the retry timer and
   asserts that no config write occurs.
3. **Flush ordering (A round 3, Medium, folded).** A normal `flush()` first
   drains the pending save (it awaits the in-flight write and runs any queued
   one), and only then closes the owner. If the bounded wait times out, it
   closes the owner at that point, and the generation fence drops every later
   retry. Tests cover both paths: normal stop with a pending save persists it,
   and a timed-out stop writes nothing afterwards.
