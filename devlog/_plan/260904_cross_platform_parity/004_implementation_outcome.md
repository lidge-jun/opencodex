# 004 - Implementation outcome

What actually landed for `260904_cross_platform_parity`, what review changed, and
what the plan got wrong. Written at the close of wp3.

## The stack

| PR | Phase | Base | Head |
|---|---|---|---|
| [#3436](https://github.com/lidge-jun/opencodex/pull/3436) | wp0 roadmap | `dev` | `codex/260904-cross-platform-parity-roadmap` |
| [#3437](https://github.com/lidge-jun/opencodex/pull/3437) | wp1 Muse manual key | #3436 | `codex/260904-muse-platform-refusals` |
| [#3440](https://github.com/lidge-jun/opencodex/pull/3440) | wp2 platform-support docs | #3437 | `codex/260904-platform-support-docs` |
| [#3438](https://github.com/lidge-jun/opencodex/pull/3438) | wp3 identity decode | #3437 | `codex/260904-windows-identity-decode` |

wp2 and wp3 are siblings on wp1 rather than a chain: neither touches the other's
files, and serializing them would have made the second wait on the first for no
reason.

## What review changed

**The plan was cut from five phases to three, across six audit rounds.** Two of
the removals were defects in my own design, not scope trimming:

- The legacy scheduler-task migration would have re-registered a DIFFERENT user's
  task to the current user. Matching `<Command>` and the launcher proves the task
  runs our files, not that its session triggers belong to this account.
  `tests/service.test.ts:628-641` already pinned that rejection, and my proposed
  test only checked a foreign command, never a foreign user.
- The Linux env-file port would have written a token-bearing `claude-env.sh` with
  no reaper: `revertSystemEnv`, toggle-off and `cleanStaleSystemEnv` all return
  early off darwin. It also referenced `modelEnv` and `auto` before they exist
  and would not have compiled.

**Three more were things the tree already had, or already forbade.** A GUI
"disabled reason" I planned to add exists, localized, at
`gui/src/pages/claude-code-settings.tsx:43-54`. A `skip` discriminant would have
broken four exact `toEqual` assertions and reclassified real failures as benign.
The Muse plan invented pointer fields that `MusePointer` does not declare.

**Implementation review then found five more in wp1 alone**, including two worth
recording: `refreshMetaMuseToken` hardcoded `source: "local-cli"`, which
`merged()` would have used to relabel a hand-pasted key as an imported one; and
the credential-leak test caught its own sentinel, so a case that unexpectedly
SUCCEEDED passed vacuously. The second is the more instructive failure - the test
was measuring itself.

## What the plan got wrong

**wp1's scope was wrong until the repository owner corrected it.** Both drafts
shipped refusals, on the reasoning that we cannot read the credential store on
Windows or Linux. That is true and beside the point: the Muse Code API key is
visible in Meta's own console, so refusing the platform reported a limitation of
our importer as a limitation of the platform. The phase became manual key entry.

**#3320's causal claim was overstated.** `003` originally called the decode
defect the root cause. The reporter's evidence was collected after a local
repair, so the original registration shape was never observed. The defect is real
and verified in the tree; the link to that report is a candidate, which is why
#3438 references the issue instead of closing it.

## Verification

The user forbade running the full local suite, so CI is the suite authority. Per
phase:

- wp0: docs-only; all 8 workflow runs on the branch concluded success.
- wp1: `tests/meta-muse-oauth.test.ts` + `tests/oauth-manual-code.test.ts`, 52
  pass. Leak guard driven red first.
- wp2: `bun run --cwd docs-site build`, 425 pages, exit 0, plus a hand check of
  the localized sidebar href because a manual `link` is not build-validated.
- wp3: `windows-user-principal-nonascii` + `windows-user-principal`, 25 pass;
  `windows-secret-acl` (the `identity.name` consumer), 169 pass. Guards driven
  red first: 5 of 9 fail against the old UTF-8 decode.

`bun x tsc --noEmit` clean at every commit.

## One process note

The subagent review lane died with a provider 401 for the last three phases
(`No eligible Codex account supports this model`). wp2 and wp3 were therefore
audited first-hand and their attests say so, with `near-pass` rather than
`pass` and the residual recorded. An audit nobody independent performed should
not be labelled as though someone did.

## Not done

Everything in `050`, each with its blocking reason. The two that matter most: the
legacy name-form task migration needs a trusted name-to-SID resolution channel,
and the Linux env-file port needs the credential review `AGENTS.md` mandates.

