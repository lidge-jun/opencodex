# Audit round 1 — synthesis

Verdict: **FAIL**, 7 High plus 3 Medium and 1 Low. Independent reviewer, auditing
the roadmap against the real tree rather than against its own claims.

What survived matters as much as what failed, so it goes first.

## Confirmed by the reviewer

- The **overturned conclusion is justified.** The full operation-state engine is
  not inherently required for "OFF means converge to native/standard mode". The
  predecessor unit's central finding really was too strong.
- The **official Anthropic citation is genuine.** The reviewer opened
  the configuration reference itself and confirmed both the standard-mode
  sentence and read-once-at-launch.
- Pi's `text|image` restriction is real, re-confirmed from current upstream docs.
- Absent `clientIntegrations` keys really do default ON.
- The whole-catalog modality assertion really would have caught the gjc bug.
- Numbered lexicographic split and diff-level coverage are satisfied.

So the direction holds and WP2 is clean. Everything below is about the machinery
the roadmap put around it.

## The one defect seen five ways

Findings #2, #3, #4, #6 and #7 are one thing: **I designed a flag and called it a
state machine.**

A durable boolean answers "what does the user want". It does not answer:

- who writes it safely when two processes write at once (#2)
- who writes it at all for six of the ten clients (#3)
- what the CLI prints when it skips because of it (#4)
- what stops an in-flight writer that read it before the flip (#6)
- what converges observed state when we crash between persist and mutate (#7)

I dropped the operation-state engine because its *rollback* half was
disproportionate. That was right. But the engine also carried a *coordination*
half — single-flight, ordering, restart reconciliation — and I dropped that too,
without noticing it was load-bearing for a different reason.

#7 is the sharpest version. I wrote in `003` that a boolean "survives a restart",
which is true of the boolean and false of the system: persist OFF, crash before
the remover runs, and restart merely *skips future writes*. Desired OFF, observed
ON, forever, with nothing that ever reconciles them. The reviewer is right that
this is not established by anything I wrote.

**Disposition: accept all five.** The replacement is not the old engine. It is
three specific mechanisms, and they belong in WP3 where the flag lives:

1. **Field-scoped persistence.** `mutatePersistedConfig` already exists
   (`src/config.ts:1854`) — I specified `saveConfigPreservingClaudeCode` without
   checking whether the better primitive was already in the tree. It was. This
   also removes the "mutate live object before persisting" bug the reviewer found
   in the shipped route.
2. **Per-client single-flight around every irreversible write**, with desired
   state re-read immediately before the write, not only at entry.
3. **Startup reconciliation**: desired OFF is a *converge* instruction, so
   startup re-runs the idempotent remover rather than only skipping.

That is meaningfully smaller than a versioned discriminated journal with
prepare/commit, and it is what the evidence actually demands.

## The finding I most need to accept, and why

**#1 — removing the Claude transport gates.** I had flagged this myself as the
decision most likely to matter, and the reviewer's judgment is that it is wrong.

My reasoning was the invariant "disabling an integration means stop writing that
client's config, never stop serving." That invariant is correct **for
installation state** and I over-applied it to **ingress admission**.
`claudeCode.enabled` is documented and implemented as the kill switch for
`/v1/messages` (`src/server/claude-messages.ts:65-69`) and empties Anthropic
discovery (`src/server/index.ts:496`). An upgrading user whose switch reads OFF
would silently get an ingress that starts accepting traffic again. That is a
shipped-behavior regression dressed as a principle.

**Accept.** Keep both gates, drive them through
`clientIntegrationEnabled(config, "claude-code")`, and add the compatibility test
proving a legacy `enabled: false` config still gets 403 and an empty model list
after migration. The invariant survives in its correct form: Codex OFF must not
close `/v1/responses`, which no client-specific gate ever guarded.

## #5 — the phases do not compose

WP5 and WP6 were dispatched in parallel and each wrote a diff against the tree as
it is today, not against the tree as the other leaves it. WP6 even re-types the
client union as `"claude" | "claude-desktop" | "grok"` — dropping the Codex entry
WP5 adds.

That is my dispatch error, not the writers'. Two authors editing the same route
and the same union need one contract they both consume.

**Accept.** WP3 owns the complete shared contract: the four-client union, the
status/success response schema including `desiredEnabled`, the refusal envelope,
and the status helpers. WP5 and WP6 are rewritten against it, and they are
**sequential, not parallel**, wherever their diffs touch the same file.

## #8 and #9 — Desktop status honesty

Both accepted, and #9 is the more embarrassing: a status read that hardcodes
`installed: true` and creates the config library when metadata is missing would
manufacture Claude Desktop directories on a machine that never had Desktop. A
read must not write. Observed state gets derived from `_meta.json`'s selected id
and the selected profile's actual contents, not from our own fingerprint.

## #10, #11

#10 accepted: the test plans cover the happy paths and none of the five failure
modes above. Each new mechanism lands with the test that would catch its absence.

#11 accepted with a correction to my own habit: several line citations drifted by
a few lines, and I asserted a `lastmod` date the reviewer could not see on the
page. The semantic claim was verified; the metadata was not. Cite what the page
says, not what the sitemap claimed about it.

## Nothing rebutted

Eleven findings, eleven accepted. That is not deference — I checked #1's gates,
#2's `mutatePersistedConfig`, and #3's toggle route in the tree before accepting.

## Next

A is a loop, and a FAIL round never exits it (AUDIT-LOOP-01). The amendments
above go into `020`, `040` and `050`, WP3 absorbs the shared contract and the
three coordination mechanisms, then the SAME reviewer re-audits.

WP2 (`010_modality_boundary.md`) is untouched by every finding and stays as
written.
