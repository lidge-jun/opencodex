# Lane dispatch packets (wp2)

Six `xai/grok-4.6` subagents, dispatched in one round, fresh context each, read-only.
They run concurrently because their questions are independent; none reads another's output.

## Shared packet frame

Every packet carries the same frame, with only `SCOPE` and `QUESTIONS` differing.

- **Repository:** `/Users/jun/.codex/worktrees/b53a/opencodex`, on branch
  `codex/260910-250-regression-audit-release`. That branch adds `devlog/` commits on top of
  the freeze SHA `12c248f52`; every `src`, `gui`, `tests`, and `scripts` file is identical
  to the freeze. **Do not `git checkout` the freeze SHA** — it would detach HEAD on the
  worktree we are releasing from. Read `origin/dev` through `git show` if an exact freeze
  read is needed.
- **Comparison:** `git diff 2f3f73629...origin/dev -- <lane paths>`. `2f3f73629` is
  released `v2.49.0`; the right side is the 2.50.0 candidate.
- **Read the current tree, not only the diff.** A change is often half in the diff and half
  in an unchanged caller. Following a symbol into a file outside the lane's diff is expected.
- **MUST NOT:** no writes, edits, commits, pushes, stashes, branch changes, or
  `git checkout`/`git switch`/`git restore` of any kind; no test suite, typecheck, build, or
  install; no mutating `gh` call. Read-only `git` and `gh api`/`gh run list` only. Do not
  fix anything found — report it.
- **PROOF:** every finding needs an exact `path:line` on the candidate side, or a literal
  command with its output. Unanchored claims are re-derived by the main session, so an
  approximate anchor costs a round trip rather than being silently dropped.
- **RETURN FORMAT:** `VERDICT` (`NO-BLOCKER` or `BLOCKERS-FOUND`), then one numbered entry
  per finding with `ANCHOR`, `WHAT BREAKS` (the concrete user-visible failure and the input
  that triggers it), `CLAUSE` (a number from the list below, or `non-blocking`), and
  `CONFIDENCE` (`certain` / `likely` / `needs-runtime-check`). Then `FILES READ`.
- **DECISION BOUNDARY:** the lane reports evidence and unresolved judgments. It does not
  decide whether the release proceeds, does not rank against other lanes, and does not
  weaken a finding because it looks hard to fix.

### The eight blocker clauses, carried inline

A lane cannot answer `CLAUSE` from a file it was not given, so the list travels with the
packet: (1) regression against 2.49.0; (2) crash, hang, or unbounded resource use on a
reachable default path; (3) new-path functional breakage — a feature added in this delta
that does not do what it claims, even though it is not a regression; (4) security or
privacy weakening; (5) user-consent or identity-spend bypass; (6) core invariant violation
(Lab reaching `src/router.ts`, `src/server/lifecycle.ts`, or `src/server/responses/core.ts`;
an `await` in the synchronous `startServer` activation window; a tracked gitlink);
(7) upgrade-path breakage for an existing 2.49.0 install; (8) broken release, packaging,
or operator-surface contract.

A lane that finds nothing returns `NO-BLOCKER` and its `FILES READ`. A short honest
return beats a long speculative one.

## Per-lane questions

**L1 — responses and request pipeline.** Does the hosted web-search bridge arm only when
opted in, and does a failure fall back rather than hang or leak? Is the search cell placed
in stream order, and are bridge continuations bounded? Does `src/web-search/ollama-executor.ts`
bound its own errors and timeouts? Does the non-streaming context-overflow classification
return a classified reply on every exhausted-target path? Does agent-task recovery on a
mid-thread model switch preserve encrypted content? Does the configurable body admission
limit still have a safe default and reject rather than buffer? In `src/claude/inbound.ts`,
does emitting mid-conversation `role:"system"` as chronological `developer` items change
what the model obeys on an ordinary Claude Code turn? In `src/server/responses/codex-ws-wire.ts`,
what is the cost of the 30s to 90s prelude timeout when the upstream is actually hung?
Does the new `account` filter in `src/server/request-log.ts` match the value that is
actually stored, including when masking is on? Does the OpenCode Zen free-tier message
rewrite in `src/server/chat-native.ts` alter a paid-tier request?

**L2 — codex accounts, quota, OAuth.** Can a deferred validation leave an account neither
usable nor visibly failed? Does a revoked pool grant reach a terminal verdict instead of
retrying forever? Does clearing reauth state ever clear it for the wrong account? Does the
new account plan field ever carry a value that identifies the user into a log or the wire?
Does `src/oauth/health.ts` report healthy for an account that cannot actually serve? Does
the quota-header dual-write in `src/codex/quota.ts` ever attribute one account's window to
another?

**L3 — catalog, providers, combos, config.** Does free-model classification ever mark a
paid model free, or drop a model whose `pricingStatus` is absent rather than `"free"`?
Does quota-exhausted inactive marking recover when quota returns? Does the AI Studio
discovery restoration change behavior for custom gateways? Can a cross-provider blocked
model redirect cycle? Does the keyless free-tier `MissingSessionID` rewrite in
`src/providers/opencode-zen-rate-limit.ts` mask a real auth failure? In `src/config.ts` and
`src/types/config.ts`, what do `privacy.maskEmails` and the inbound body limit resolve to
when the key is absent or malformed — does the schema degrade to a safe default or to
`undefined`? Does the `zcode` config export leak anything it did not before?

**L4 — management API, service, GUI.** Does any management route lose its auth check? Does
the routed-account label reach a response a browser can read without a session? Does the
launchd bootout recovery ever tear down a healthy job? In `gui/src/pages/models-shared.ts`
and `Models.tsx`, can `freeOnlyInForce` stay true after the control disappears and leave
the user with an empty model list? Does the decode-rate column
(`src/server/management/shared.ts`, `gui/src/pages/Logs.tsx`) stay out of request history
as intended, and is the rate meaningful when the sample is tiny? Do the nine non-English
locales carry the keys this delta actually added — `models.freeOnly`,
`models.inactiveNoCredit`, `logs.detail.decodeTokPerSec`,
`pws.healthLabel.validationPending` — and does any translation invert the meaning of the
English source? Does the account-pool `validationPending` copy tell the operator what to do?

**L5 — security, privacy, release surface.** Is email masking on by default in the resolved
config, and does the opt-out require an explicit operator action? Read every log call site
added in this delta and name any that can emit an address, token, request body, or account
identifier — static reading only, do not run the scan. Does any `src/lab/` module now reach
`src/router.ts`, `src/server/lifecycle.ts`, or `src/server/responses/core.ts` through any
import chain? Is there any `await` in the synchronous `startServer` activation window in
`src/server/index.ts`, and does the bind-time `maxRequestBodySize` wiring there agree with
the configured limit and its default? Is any gitlink tracked?

**L6 — operator CLI surface.** Does `ocx status` apply the same masking default as the
library? Does `ocx account refresh` mint or reuse a dashboard session, and does it spend
the user's identity without the code-level gate? Does `--free-only` drop models with an
absent `pricingStatus`? Does `--account` filtering match on a value that is masked in the
stored log? Does the committed `skills/ocx` surface map name any command
`src/cli/capabilities.ts` does not register?

## What the main session does with the returns

Nothing is accepted on the lane's authority. Every `BLOCKERS-FOUND` entry is re-derived
against the tree before it enters the wp2 findings table, exactly as the round-1 roadmap
findings were. `040_triage_protocol.md` governs from there.
