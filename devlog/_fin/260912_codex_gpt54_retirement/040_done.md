# Closing record

## Outcome

DONE. `gpt-5.4` and `gpt-5.4-mini` no longer exist on the Codex (ChatGPT OAuth) login
surface, and every default that used to dispatch one of them now uses `gpt-5.6-luna`.
Delivered as PR #4327 against `dev`, final head `32bd5417cb`, CI green.

Commits: `a8b26e1342` (this roadmap), `5d664b1a6b` (the retirement),
`fa1fe32890` (a combo-alias fixture CI caught), `fe01c0f605` (the resurrection guard a
review caught), `32bd5417cb` (the migration extracted and tested).

## What changed against the plan

Two reversals, both from audit rather than from build convenience.

The pinned rows in `src/codex/data/upstream-models.json` stayed. The plan called for
deleting them; the A phase found the file is upstream's snapshot by contract
(`metadata.ts:580`) and already carries rows this runtime does not expose (`gpt-5.2`,
`codex-auto-review`). Both maps built from it iterate `NATIVE_OPENAI_MODELS`, so the
rows are unreachable once membership is gone. Deleting ~205 lines would have changed
no behaviour.

The maintainer-facing `docs/` tree was missing from the original scope entirely. The
independent reviewer caught it: `docs/shadow-call-intercept.md` still claimed the
default intercept set was both slugs when the code had been luna-only for a while, and
`docs/codex-app-model-catalog.md` used `gpt-5.4` as a staleness example.

## What CI caught that reading did not

Two defects survived the audit and the six parallel test workers, and were found only
by pushing:

1. `tests/codex-integration/codex-catalog.test.ts` had a native-alias combo fixture
   targeting `codex/gpt-5.4-mini`. Once membership was gone that alias had no native
   capabilities to inherit. `gpt-5.5` carries an identical pinned shape (272k window,
   `low..xhigh`, default `medium`, text and image), so every asserted value held after
   repointing.
2. `enforce-target` fails on any `gui/` path change without screenshot evidence. There
   is no visual change here, so it was waived through the repository's documented
   maintainer-comment mechanism with a note stating exactly what the `gui/src` diff is.

## What the final review caught that CI did not

CI was green and the change was still wrong in one place. An independent reviewer read
the pushed diff and found that removing the slugs from `NATIVE_OPENAI_MODELS` does not
keep them out: an account-bound observation deliberately admits any native that is NOT
in `SUPPORTED_NATIVE_OPENAI_SLUGS`, which is how a genuinely new upstream model reaches
one entitled account early. A retired slug fails that same test, so a stale
`selector/gpt-5.4` row persisted in a user's catalog or models cache would have been
re-observed as an unknown native and synthesized straight back into the picker, one sync
after the removal took it out.

`RETIRED_NATIVE_OPENAI_MODELS` is the distinction the code was missing: unknown-and-new
is admitted, known-and-dead is refused. The guard sits in `observedAccountBoundNativeSlug`
because every observation path funnels through it.

This is the residual wp2 recorded as needing proof rather than assumption, and it is the
reason that residual was worth writing down: no test covered it, so no test failed.

The same review noted the widened startup migration had no test at all. It is now
`src/codex/retired-model-migration.ts`, shaped like the existing
`runClaudeAuthModeMigration`, with tests for the three stored slugs, sibling-key
survival, idempotence, and leaving any other model alone.

## Verification and its limits

The owner instructed mid-loop that the local suite must not be run on this machine; a
baseline run confirmed why, reporting ~279 failures unrelated to this change. So
`bun run typecheck`, `bun run test`, `bun run structure:check` and the dashboard lint
are **NOT RUN locally**, and the evidence is repository CI against the final head.
`bun run privacy:scan` and `tests/ci-workflows/repo-hygiene.test.ts` were run before
that instruction arrived, on the devlog commit, and both passed.

What this does not prove: nothing here exercised a live ChatGPT account. That the
retired slugs now 404 upstream is the premise of the task, not something this unit
verified.

## What did not improve, and what would falsify this

The `desktop-3p` 1M-native regression lost its positive control. `gpt-5.4` was the only
native with a 1M window, so the test that proved a provider cap can take `supports1m`
away now only proves no native ever gets it. If a 1M native returns, that test should
regain a positive case rather than stay an absence check.

The account-namespaced question turned out to be the real defect rather than a caveat,
and it is now fixed and tested. What remains unproven is the disk side: a persisted
`selector/gpt-5.4` row is no longer re-admitted as evidence, but
`isUnsupportedOpenAiNativeSlug` still returns false for any slug containing `/`, so the
stale row itself is not actively deleted from a user's catalog file. It stops being
regenerated and stops being observed; whether it lingers in a file until the next full
rewrite was not measured against a real installation.
