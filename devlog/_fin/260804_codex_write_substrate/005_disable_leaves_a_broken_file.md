# A disable left two clients broken, and one of them invalid

Field report, 260804. Not a hypothetical: the owner hit it while using the
product, and it lands in this unit because it is the same class of defect the
substrate exists to prevent.

## What the owner saw

`gjc` ran `/provider` and opencodex was not in the list. Pi was worse — it
refused to start at all:

```
Error: models.json error: Invalid models.json schema:
- providers: must have required properties providers
  File: /Users/jun/.pi/agent/models.json
```

## What was actually on disk

`~/.pi/agent/models.json` was **three bytes**: `{}`.

`~/.gjc/agent/models.yml` was seven lines — the user's own `profiles:` block and
nothing else. No `providers:` key at all.

The integration journal explains both:

```
disable pi     2026-08-03T13:50:15Z  /Users/jun/.pi/agent/models.json
disable gajae  2026-08-04T01:02:56Z  /Users/jun/.gjc/agent/models.yml
```

Those disables came from investigative work in this project's own sessions. The
integration was never re-applied, and nothing ever told the user their clients
were now unconfigured.

## The two distinct defects

**1. Disable can leave a file that is invalid, not merely empty.**

Pi's schema requires a `providers` key. Removing our block removed the last
provider, so the writer left `{}` — syntactically fine, semantically illegal.
The client does not fall back; it refuses to load. Removing the only occupant of
a required container is not the same as removing an occupant, and the writer does
not distinguish them.

gjc degrades more gracefully — it drops back to its built-in list — but the
outcome is the same for the user: the routed models are gone with no explanation.

**2. Nothing reconciles an integration that is off but should be on.**

This is exactly the gap `../260803_codex_desktop_toggle/003_durable_desired_state.md`
named for Codex and Grok, seen from the other side. There is no desired state, so
there is nothing to notice that observed state has diverged from it. A disable
performed for one purpose stays in effect indefinitely, silently, across restarts.

## Why it belongs to this unit

`000_plan.md` C10 already says an artifact that did not exist before apply must be
*removed* on convergence, and C11 says `unchanged` desired state must still
converge observed state. This incident is the concrete proof that both criteria
are load-bearing rather than theoretical:

- C10's inverse case is here — Pi's file DID exist before apply and had to keep
  existing in a **valid** shape after removal. The provenance ledger in
  `040_ownership_convergence.md` records baseline state precisely so a remover can
  tell "restore to absent" from "restore to a valid minimal document".
- C11 is the reason a user should never be left in this state for a day: with
  desired state recorded, startup convergence sees ON-with-missing-artifacts and
  re-applies.

**Amendment to `040`:** the artifact inventory must treat "the client's schema
requires this container to be non-empty" as a distinct baseline class. Removing
the last member is either a restore-to-baseline (if we created the file) or a
restore-to-valid-minimum (if it pre-existed) — never a bare `{}` unless `{}` is
what was there before us.

## Immediate remediation performed

Both files were re-exported from the dev tree and verified:

| | Result |
|---|---|
| `~/.pi/agent/models.json` | `providers.opencodex`, 34 models, no out-of-enum modality |
| `~/.gjc/agent/models.yml` | gajae's real `ModelsConfigSchema` **PASS**, 34 models, user `profiles:` preserved |

The gjc merge appended our block to the existing document rather than replacing
it, so the user's `codex` profile survived. Prior copies are at
`/tmp/pi_models_before.json` and `/tmp/gjc_models_before.yml`.

Both files now also carry the WP2 modality fix, so the `audio` value that broke
gjc's whole config is gone from the emitted output.

## Follow-up owed

`FOLLOWUP-FILECLIENT-01` (the six file clients' desired state, deferred from the
prior unit) now has a user-visible incident attached to it. The empty-container
defect is narrower and should be fixed in the writer regardless of when that
follow-up runs.
