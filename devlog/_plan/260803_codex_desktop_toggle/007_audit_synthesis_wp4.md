# WP4 audit — synthesis

Verdict: **FAIL**, 4 High blocking plus 3 Medium. Fresh reviewer, auditing the
re-scoped Codex-only doc.

## What the re-scope bought

The reviewer confirmed, by independent grep and trace, the things the previous
two rounds kept failing on:

- **It really is Codex-only.** No surviving non-Codex gate, writer, or type
  change; the Claude/Grok/Desktop/file-client mentions are exclusions or the
  auth-sentinel proof.
- **The flag shape is extension-safe** and absent-key-means-ON holds against the
  real load/save path.
- **The auth-sentinel claim holds**, and holds even when a second key is added
  under `clientIntegrations`.

So the diagnosis in `006` was right: slicing by ownership fixed the divergence.
Three rounds of findings about coupling are gone in one pass.

What replaced them is narrower and, unlike the previous rounds, all of it is
about **Codex itself**.

## The one defect behind #1 and #2

I designed a check where I needed a lock.

`#1`: my "re-read intent immediately before the write" closes a window, it does
not eliminate one. An apply reads ON, another process commits OFF through the
*separate* config lock, and the apply proceeds into `atomicWriteFile`. Every
check/write pair has that gap, including the several writes hidden inside one
history callback. My own test would have passed while the bug was live, because
it flips OFF *before* the check rather than between check and write.

`#2`: the ownership preflight fails open by design
(`ownership-preflight.ts:21`), and `readServiceInstallState` returns `null` for
corrupt, unreadable, and missing-mirror states alike (`service.ts:165`). That is
defensible for an interactive route where a human reads a refusal. It is wrong
for **unattended startup convergence**, where fail-open means "remove a foreign
home's Codex state and tell nobody". Worse, my ordering was wrong twice over:
startup runs `reconcileJournal` before my preflight, and my own flight database
would be created under `$CODEX_HOME` before the preflight runs — so the
"byte-exact refusal" claim is already false by the time the check happens.

**Accept both.** The replacement:

- one per-`CODEX_HOME` linearization lock covering **both** desired-state commits
  and native commit sections, with model gathering left outside it
- a tri-state ownership answer — `owned | foreign | unknown` — where automatic
  convergence fails **closed** on `foreign` and `unknown`
- ownership resolved before journal repair and before any lock artifact exists,
  with the lock stored outside `CODEX_HOME`, keyed by canonical-path hash

## #3 — the artifact I did not know about

`restoreNativeCodex` restores config, profile, catalog and history. It never
touches `models_cache.json`, and apply writes routed data there
(`catalog/sync.ts:600`). So a converged OFF can report success while native
Codex still advertises routed models from the integration we just disabled.

This is the same shape as the WP2 bug: a state that only shows up in the real
artifact, invisible to a test that asserts the artifacts it already knew about.
Cache restoration joins the remover and the observed-state inspection.

## #4 — the command I gated without deciding what it means

`ocx restore back` is the documented reverse switch (`cli/help.ts:18`). I gated
`syncModelsToCodex` beneath it and never said what the command does when Codex is
durably OFF — so it either cannot perform its documented job, or prints "now
routes through opencodex" after writing nothing. That is the false-green class
again, one phase after I wrote a doc section about it.

Resolution, adopting the reviewer's split:

| Path | Behavior while OFF |
|---|---|
| `POST /api/sync` | 409; an automatic-ish surface does not override intent |
| `ocx sync` | refuse, naming the switch |
| `ocx restore back` | **explicit enable**: persist ON atomically, then apply |
| `ocx init` | may establish ON — it writes a fresh config and asks separately |

And a skipped sync returns `ok: false` with a `skippedReason`, not a bare `ok`
that every caller reads as success.

## Medium findings

- **#5** `mutatePersistedConfig` **throws** `ConfigMutationLockError` on lock
  contention; `unavailable` means rebase exhaustion. I documented three outcomes
  and missed the thrown branch, so a route following my instructions leaks a 500.
- **#6** two processes sharing `OPENCODEX_HOME` with different `CODEX_HOME`s can
  both write the legacy `catalog-backup.json`. The hashed backup usually masks
  it, which is exactly why it needs a test rather than a comment.
- **#7** SOT-SYNC: `docs-site` lifecycle pages still promise unconditional
  sync/restore-back. A user-visible command semantics change has to land there.

All accepted.

## Next

A is a loop; a FAIL never exits it. Amendments go into `030`, then the SAME
reviewer re-audits. Nothing about the phase map changes — this round produced no
evidence of divergence, only of Codex being genuinely concurrent.
