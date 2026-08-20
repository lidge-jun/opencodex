# 080 — Residual dispositions: #2115, #2054, #2032, #2067, #2082, #2027, #2155

Unit: 260820_bug_pr_backlog_consolidation
Work-phases: wp15 (this doc's first three), wp16-wp19 (one PR each), wp20 (closeout).
Baseline: origin/dev; worktree branch `codex/fix-subagent-roster-truncation`.

The wp1 rubric put six PRs below the 60 threshold and left them open. The user reviewed
that reasoning and issued explicit per-PR dispositions, plus one new arrival (#2155). This
doc records the dispositions and the evidence each one rests on. Evidence came from five
read-only gpt-5.6-sol investigation lanes that read every diff and the surrounding runtime.

## wp15 — the three that need no new code

### #2115 @louis-tepe — CLOSE

The PR is titled as Code Mode edit guidance, but `src/adapters/openai-chat.ts:548` swaps the
local "hostname is exactly api.openai.com" test for a new `isCanonicalNativeOpenAIRoute`
predicate in `src/adapters/tool-catalog-nudge.ts:118-132`. That predicate is not
prompt-only. Through `messagesToChatFormat` (`openai-chat.ts:629`) it decides whether
developer messages stay as ordered `role: "developer"` entries or fold into the leading
system message; through `toolChoiceToChatFormat` (`:1232-1246`) it decides whether a single
required tool becomes a forced named function; and through `buildRequest` (`:1333`) it
decides native `reasoning_effort` versus gateway-style `reasoning`. One predicate change
therefore moves three wire semantics that have nothing to do with edit guidance.

Second defect, independent of the first: `codeModeExecName` is withheld when a bare shell
bridge is present (`tool-catalog-nudge.ts:203-207`), but the new suffix injection checks
only `codeModeExecTool` (`:214-218`). A freeform `exec` sitting beside a top-level
`exec_command` still receives "targeted code edits" guidance even though the repository's
own predicate classifies that catalog as not Code Mode — a contract pinned at
`tests/tool-catalog-nudge.test.ts:114-123`.

Blast radius if the guidance predicate is wrong: every routed Code Mode request on
Anthropic, Google/Vertex/Antigravity, Command Code, and every OpenAI-compatible host
without a literal `openai`/`chatgpt` DNS label — gateways, DeepSeek, Groq, Ollama, vLLM,
LM Studio, custom routes. Kiro (`src/adapters/kiro.ts:466-469`) picks up the reworded
generic sentence without being able to receive the suffix at all.

The underlying request is legitimate. The implementation is not absorbable as-is because
the correct version is a narrower Code Mode seam that does not redefine native route
identity.

### #2054 @keepitmello — STAY OPEN, probe requested

The PR stores Cursor's returned `ConversationStateStructure` and replays it as the next
`AgentRunRequest.conversation_state` instead of rebuilding history every turn
(`src/adapters/cursor/protobuf-request.ts:823` on dev is the full-replay path). The
hypothesis is that full replay defeats Cursor's own checkpoint cache and produces the
large-context collapse in #1527.

The PR proves the request construction changed — smaller `rootBytes` — and states plainly
that it did not reproduce the `kimi-k3` collapse or the 429. So the causal link is exactly
the thing still missing, and it is cheap for the author to capture: a matched three-turn
baseline-vs-head run at the issue's 75k-95k token shape, recording per turn the request
`conversation_id`, a digest and byte length of `conversation_state`, its
`root_prompt_messages_json` count, `turns` count, and `token_details.used_tokens`, against
the same fields on the response's `conversation_checkpoint_update`. The decisive comparison
is whether turn N+1's request state equals turn N's returned checkpoint while
`conversation_id` holds. `ocx debug provider on` / `ocx debug provider logs -f`
(`docs-site/src/content/docs/reference/cli/agents.md:102`, `src/lib/debug.ts:15`) already
carries the construction mode; exact state equality needs payload-free digests added
locally.

Checkpoint reuse WITHOUT the collapse disappearing would refute the causal claim, which is
why the request is worth making rather than guessing.

### #2032 @yzxcj797 — CLOSE

This is a decision that was already made by a human, not a scoring call. The maintainer's
CHANGES_REQUESTED review says it directly: "Passing --dangerously-skip-permissions does not
create an OS sandbox" and "A viable revision needs a real sandboxed launch path, or it must
leave the vendor root guard intact."

The diff injects `IS_SANDBOX=1` whenever the flag appears in argv (PR head
`src/cli/claude.ts:126-131`, `:329-331`) with no UID check and no sandbox establishment,
so it suppresses Claude Code's root guard while the child keeps ordinary root filesystem and
process access. The added tests (`tests/claude-cli.test.ts:271-295`) assert environment
assembly, not an isolation boundary. It also carries an unrelated `package.json` version
bump to 2.25.0.

On dev, opencodex does not drop, refuse, or warn about the flag: `src/cli/dispatch.ts:500`
forwards trailing args and `src/cli/claude.ts:338` passes them through unchanged. The
refusal comes from Claude Code itself. A user who has genuinely isolated their environment
can already export `IS_SANDBOX=1`, because `buildClaudeEnv` starts from the caller's
environment (`src/cli/claude.ts:76`) and the docs promise exported variables win
(`docs-site/src/content/docs/guides/claude-code.md:56`).

## wp15 outcome (executed)

| PR | Action | Receipt |
|---|---|---|
| #2115 | CLOSED with reason | `issuecomment-5349122248`, state CLOSED |
| #2054 | comment only, left OPEN | `issuecomment-5349122708`, state OPEN |
| #2032 | CLOSED with reason | `issuecomment-5349122937`, state CLOSED |

Verified by `gh pr view <n> --json state` after the fact, not from the write's own exit code.

## wp16 — #2067 @waw4303: ABSORB, and the reason is external corroboration

The user's instruction was to check how **omniroute** — a separate open-source project
brokering free quota against the same upstream — builds these headers, then decide. That
turned out to be the decisive evidence, and it moved the answer.

The PR head changed while the lane was reading it. The original commit `a5183abb` sent
`opencode-cli/1.0.0` / `cli` / `default`; the current head `6a79c42e` sends only
`User-Agent: opencode` alongside the existing `x-opencode-client: desktop`.

omniroute (`diegosouzapw/OmniRoute`, commit `3d7ed7aa`, 2026-08-19) resolves the same
headers in `open-sse/executors/opencode.ts:408-448`:

```ts
userAgent: process.env[envUAKey]?.trim() || process.env.OPENCODE_USER_AGENT?.trim() || "opencode",
client:    process.env.OPENCODE_CLIENT?.trim()  || "desktop",
project:   process.env.OPENCODE_PROJECT?.trim() || "global",
```

It does not fetch or derive an installed CLI version at runtime. It falls back to a bare
unversioned `opencode`, preserves a real incoming `opencode-cli/<version>` when one exists,
and lets an operator override via env.

Three-way comparison:

| Header | ours today | #2067 head | omniroute |
|---|---|---|---|
| `User-Agent` | absent (uncontrolled runtime default) | `opencode` | `opencode`, configurable, preserves real `opencode-cli/<v>` |
| `x-opencode-client` | `desktop` | `desktop` | `desktop`, configurable |
| `x-opencode-project` | absent | absent | `global`, configurable |
| `x-opencode-request` | absent | absent | fresh UUID |
| `x-opencode-session` | absent | absent | conversation-derived or UUID |

The important finding is the one that reverses a wp1 assumption. wp1 scored this 38 partly
because a pinned CLI version marker has a short shelf life — and that criticism was correct
against `a5183abb`. omniroute made the same mistake and then deliberately backed it out:
its July implementation (`234956dd`) used exactly `opencode-cli/1.0.0` / `cli` / `default`,
and PR #10571 replaced them with `opencode` / `desktop` / `global`. So the version pin is
not corroborated by an independent implementation; the *revised* values are, and by one that
arrived at them by retreating from the pin.

That removes the "value with a short lifetime" objection entirely. What remains is a real
defect: we send no `User-Agent` at all today (`src/providers/registry.ts:2427`), so the
runtime default goes out uncontrolled, which is what the reporter's 429 is attributed to.

Precedent for pinning a client fingerprint already exists here — Anthropic
(`src/adapters/anthropic.ts:936`, asserted at `tests/client-fingerprint.test.ts:120`), xAI
(`src/providers/xai-transport.ts:7`, `tests/xai-transport.test.ts:55`), Command Code with a
configurable fallback (`src/adapters/command-code.ts:482`). And the value stays
operator-overridable through the existing case-insensitive provider header override at
`src/server/management/provider-routes.ts:288`.

Decision: **ABSORB the revised shape**, not the original.

```ts
staticHeaders: {
  "User-Agent": "opencode",
  "x-opencode-client": "desktop",
}
```

Deliberately NOT copied from omniroute: `x-opencode-project`, `x-opencode-request`,
`x-opencode-session`. None is needed to fix the demonstrated failure, and adding a
conversation-derived session identifier is a privacy-relevant change that needs its own
evidence rather than a sibling project's precedent.

### wp16 outcome — and the bug the absorb uncovered

**PR #2160**, branch `codex/absorb-opencode-free-static-headers`, base `dev`. #2067 closed
with attribution (`issuecomment-5349492578`).

The audit is the interesting part. The plan as written — add the header to the registry row —
passed my own reading and FAILED the reviewer, correctly. `staticHeaders` is documented at
`registry.ts:149` as "merged into every upstream request for this provider", and that was
false. It was copied at seed time only: `providerConfigSeed` writes the block once,
`enrichProviderFromCatalog` fills it only when the whole block is absent, and nothing merged
it at request time. `rg -n 'headers' src/router.ts` returned zero hits.

Reproduced directly before accepting the finding:

| persisted config | `routedProviderConfig("opencode-free", ...).headers` |
|---|---|
| no headers block | `undefined` |
| `{x-opencode-client: desktop}` | unchanged — no UA |
| `{user-agent: custom-agent}` | unchanged — no client marker |

So the contributor's one-line registry patch would have shipped a header that **no existing
install ever receives**. The management API strips a persisted block that exactly matches the
registry set, which means the most common on-disk state is "no headers at all" — and that
state gained nothing.

Implementation, three parts:

1. `mergeRegistryStaticHeaders(staticHeaders, userHeaders)` in `registry.ts` — registry values
   fill only names the user has not claimed, compared **case-insensitively**. That last word is
   load-bearing: HTTP header names are case-insensitive but object keys are not, so spreading a
   registry `User-Agent` over a user's `user-agent` leaves both keys and `Headers` serializes
   them as `"custom-agent, opencode"` — a corrupted request wearing the costume of an override.
2. `routedProviderConfig` (`router.ts`) merges at resolve time.
3. `buildModelsRequest` (`oauth/index.ts`) does the same, because a provider identified as
   `opencode` when it completes but anonymous when it lists its own models reads as two
   different clients to a rate limiter.

Residual, stated rather than skipped: `validateApiKey` (`key-providers.ts:102`) still sends
only `Authorization`. It is an auth probe by design; widening an auth-path request shape is a
separate change with its own review burden.

Evidence: 6 new regressions; reverting only `router.ts` + `oauth/index.ts` while keeping the
registry header fails exactly 5 of them (13 pass / 5 fail), which is what makes them delivery
tests rather than restatements of the registry constant. Full suite 13519 pass / 10 skip /
0 fail across 856 files; typecheck and privacy scan clean.

One existing expectation moved: `tests/management-provider-validation.test.ts` "provider PATCH
clear keeps registry static headers" now asserts the two-header set. That is the same edit
#2067 made, and it is the correct one — the test pins the registry-owned set, which grew.

## wp17-wp19 — the three that need new code

Recorded here as each is decided; each is its own PABCD cycle.

### wp17 — #2082 @yzxcj797: AgentRouter language framing

**PR #2162**, branch `codex/absorb-agentrouter-language-framing`, base `dev`. #2082 closed
(`issuecomment-5349709140`). Fixes #2074.

The diagnosis was the contributor's and it was correct: AgentRouter answers 400
`content-blocked` on a non-English first user message while the same request in English
returns 200, and the filter reads that turn, so an Anthropic `system` string cannot reach it.

Two corrections.

**Host predicate.** `hostname.includes("agentrouter")` also matches `notagentrouter.example`
and `agentrouter.org.attacker.example`. This is a prompt mutation keyed on a provider's
identity, so the key has to be that identity exactly — otherwise an unrelated destination
quietly receives an injected instruction block. Now `agentrouter.org` or a real subdomain.

**Where the marker goes.** The original spliced it into the user's string:
`firstUser.content = \`\${MARKER}\\n\\n\${firstUser.content}\``. That edits what the user
wrote, and every downstream reader then attributes a sentence to them that they never typed —
the hidden user-turn mutation named in #1804. The framing is now its own leading text block.
It still adds content to the user turn, which is unavoidable against a filter that reads the
first user message, but additive-and-visible is a different risk class than a silent rewrite.

Idempotence is keyed on the LEADING block being exactly the marker, not a substring test: a
user who quotes the marker mid-prompt must not suppress their own framing.

Evidence: 10 regressions; reverting only the adapter fails 7. The 3 that stay green are the
lookalike-host and direct-Anthropic cases — green on unpatched `dev` precisely because `dev`
frames nobody, which is what makes them guards against the substring predicate rather than
restatements of it. Full suite 13529 pass / 10 skip / 0 fail; typecheck and privacy clean.

`CONFLICTING` was an inherited `package.json` bump alone; the Anthropic hunks merge cleanly.
No version change in the replacement.

### wp18 — #2027 @yzxcj797: OpenCode Go quota, planned

The investigation moved the answer here too. The real issue is #1924: sibling rows
(`opencode-go-2` … `-5`) show no quota in the dashboard and no rows in
`ocx provider quota --refresh --json`, because dispatch gates on the literal provider NAME at
`src/providers/quota.ts:2087`.

The contributor's fix swaps that for a base-URL comparison. Closer, but it does not check the
adapter, so a row pointed at the canonical URL with a different adapter would be probed.

The repository already has the exact predicate: `registryEntryForProviderDestination`
(`registry.ts:2678`) identifies a renamed fixed key provider by normalized endpoint + adapter
+ auth mode, and is already the convention for renamed rows
(`opencode-zen-rate-limit.ts:28-43`, `derive.ts:398-425`).

Rejected alternative, recorded: `providerMatchesRegistryTransport("opencode-go", provider)`
would need `preserveCustomDestination: true` on the registry entry, which also changes ROUTING
for a same-named custom row (`router.ts:269-274` vs `:320-336`). That may be worth doing, but
not as a side effect of a quota fix.

The defensive canonical-URL check inside `fetchOpenCodeGoQuota` (`quota.ts:485-494`) stays: it
is what stops an API key being sent to a non-canonical host, and it should not depend on the
dispatch predicate being correct.

### wp18-wp20 — the rest of the chain

**#2027 @yzxcj797 -> PR #2164.** Dispatch gated on the literal name `opencode-go`, so the
multi-account sibling rows in #1924 had no quota panel and no CLI report. The contributor's
base-URL swap is closer but does not check the adapter; `registryEntryForProviderDestination`
already answers exactly this question (endpoint + adapter + key auth) and is the existing
convention for renamed rows. Rejected: `providerMatchesRegistryTransport` would need
`preserveCustomDestination`, which also changes routing for same-named custom rows.

**#2155 @waw4303 -> PR #2165.** Field validation ran before the pending-call lookup, so a
non-string repeat of an already-canonical field killed the turn with a 502. Two corrections:
`arguments` was gated on a canonical NAME (a name is not evidence about the arguments field,
so a real payload could be dropped) — now keyed on `sawArgumentsString`; and `id` stayed
unconditionally terminal. Diagnostics now come from the rejection site, because a stateless
rescan blamed call 0's accepted padding for call 1's real defect.

**#2163 @Ingwannu -> PR #2166.** Scored 65. Backend attribution was correct; sanitization sat
at the one call site rather than in the logging layer, so `/api/logs` carried the raw
caller-supplied value. Moved into `addFinalRequestLog`. #2157 stays open: the GUI half is not
built, and closing it would claim an affordance that does not exist.

### The stack

Six layers, each rebased onto the current `dev` tip, base refs verified:

#2134 -> #2160 -> #2162 -> #2164 -> #2165 -> #2166

Only one true dependency edge exists in the whole set (none of the six share files). They are
chained rather than opened as siblings because the user asked for one reviewable stack; that is
a review-workflow choice, stated rather than dressed up as a code constraint.

A privacy-scan failure caught in CI and not locally: a test fixture API key over 24 characters
reads as a real bearer token to `scripts/privacy-scan.ts`. Fixed at the L4 commit.

### End state

`gh pr list --label bug --state open` returns only lidge-jun PRs plus #2054, which stays open
by explicit instruction and carries the wire-probe request. Nine contributor PRs closed with
attribution across this unit; none was closed without a named reason.

