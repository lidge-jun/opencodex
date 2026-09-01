# 070 — regaudit: main→dev regression audit, trailing CI, count

Terminal work-phase of the bug-label drawdown. Runs after every landing (dependsOn i1527, p3193).

## Scope

- `origin/main` = v2.39.0 promotion tip (`af6113a03`). `dev` keeps moving while this audit
  runs (other maintainers are landing feature PRs), so counts are pinned to a snapshot: at the
  first pass `origin/main..origin/dev` was 141 commits / 82 src-touching; by the second pass
  (tip `5bc6939d8`) it was 145 / 84 plus 23 tests-only commits. Every commit that entered after
  the first snapshot was reviewed in the second pass, so the union covers the whole range.
- `origin/main` is not a fast-forward ancestor of `dev` (15 promotion merge commits are unique
  to `main`); the range is still `main..dev` because promotion merges carry no source of their
  own.
- Four independent read-only reviewers (xai/grok-4.6): two split the src-touching commits and
  hunt behavioral regressions for a default-config user (broken previously-working paths,
  credential leaks, Node-only APIs, changed status/error contracts, reintroduced bugs); one
  covers the tests-only commits (does any weaken a guarantee?) plus the two newest feature
  commits; one runs the MAINTAINERS.md security-boundary pass over workflows, release tooling,
  auth-cors, service-secrets, remote, management, and client code, and confirms
  `privacy:scan` stays wired in CI.
- Trailing CI on `dev` is judged here, per the user's "CI 후행" policy. Push-triggered runs on
  `dev` skip the Windows shards (`platform-windows` is `workflow_dispatch` only) and are
  cancelled by the next push, so an exact-head verdict needs a `workflow_dispatch` on the tip:
  branch `codex/regaudit-ci-5bc6939d8` = `origin/dev` tip, run 33552542958.
- Every bug-train landing SHA is re-proven an ancestor of `origin/dev`.
- The devlog stack (`codex/260902-bug-pr-closeout-stack`) lands as its own docs PR.
- Final recount against c-7.

## Landing ancestry (re-proven this cycle)

#3174 e582aee21, #3176 2e2da87b5, #3177 0d6424f80, #3178 51c49177f, #3179 eceb02d9d,
#3180 634d9e5a0, #3182 865a36ef0, #3183 fecb77a91, #3184 afd5b4630, #3185 fe766e129,
#3186 ea29e25b0, #3187 d33557064, #3188 5ccf7c800, #3189 5557772b7, #3194 c87071400,
#3195 f3bcc67a7, #3196 52d941640, #3197 4be4326d7, #3198 ef6a163c7, #3199 c17bc94c2,
#3200 fcf0da257, #3201 c7f3f6f31, #3202 59449fa83, #3203 55400efd5, #3205 53c09a247 —
all `git merge-base --is-ancestor <sha> origin/dev` exit 0.

## Trailing CI on dev

Most runs in the train were **cancelled** by the next push (concurrency group), so the signal is
the runs that completed:

| run | head | result | failing job → test | classification |
|---|---|---|---|---|
| 33543314151 | 52d941640 (#3196) | failure | test 2/4 → `provider-quota` "pool reports tolerate a malformed persisted plan" | **real, already repaired** by #3200 `fcf0da257` (test moved onto the #3198 contract) |
| 33543314151 | 52d941640 | failure | macos → same provider-quota test | same |
| 33546279148 | fcf0da257 (#3200) | failure | macos → `lab-live-pinned-timeouts` "preserves the output byte ceiling as output_byte_limit" received `first_byte_timeout` | **flake**: `firstByteTimeoutMs: 30` in `BASE_LIMITS` races the loopback server on a loaded macOS runner; the test and `src/lib/lab-live-pinned-sender.ts` are unchanged since `d9655f31b`, which is already on `main`. Linux shards 1-4 passed the same file. |
| 33520193493 | 9232df0e6 | failure | test 3/4 → responses-state "shutdown drain cap expiry" | pre-train, timing flake (not in this campaign's diff) |
| 33514747317 / 33477777613 | 408652698 / 58be3c5bb | failure | macos → port-selection / websocket pool auth | pre-train macOS timing flakes, same family the memory notes as known |
| 33549107560 | 0d73d6557 (#2986, not ours) | failure | macos → `codex-prompt-route` "36. comment-after-bracket fallback project document with a bare key" expected in-flight probe refusal, received a completed probe | **flake**: the case races a 200 ms probe against the second GET; the quoted-key sibling passed in the same run; the file is untouched since `main` (`aa16a71e0`); no other run in this train hit it. |
| 33548615686 / 33550885829 | 6a6efa928 / 4a382beed (not ours) | cancelled | — | superseded by the next push |
| 33551966282 | 5bc6939d8 (#3209, not ours) | push-triggered | — | tracked; Windows skipped |
| 33552542958 | 5bc6939d8 | **workflow_dispatch, exact head, Windows shards on** | — | the promotion-grade verdict for this audit; recorded in 071 |

Last fully green dev run before the train: `22a643a00` (2026-09-01T16:41Z). Verdict on the train
so far: one genuine CI regression (#3196's test contract drift) which was caught and repaired
inside the train by #3200; no other failing job points at a commit from this campaign.

## Reviewer verdicts

Full text in `071_regaudit_landing.md`. Summary: all four passes returned `VERDICT: pass` with
no high-confidence default-path regression. Medium suspects are design decisions on opt-in or
non-default paths (unreadable `config.json` now fails closed in `ocx start`; streaming provider
413 becomes a terminal SSE overflow; launchd Claude mode ignores dotenv-only Anthropic env;
compaction without a canonical OpenAI route forwards to the default provider). Two security
residuals are recorded for follow-up, neither a new grant: live `service-api-token` reads skip
the owner-only mode check that `.prev` enforces; hub `managementPublicOrigin` replaces the
observed scheme so pairing cannot see TLS-stripped HTTP on the public listener (the official
client already refuses plaintext).
