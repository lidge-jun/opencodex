# 100 — Release-safety audit of origin/main..origin/dev

Unit: 260820_bug_pr_backlog_consolidation
Range: `8e01dd4e8..a584890f8` — 87 commits, 22 merges, 108 changed files.
Verification host: `ssh lidge:~/ci-wp3/opencodex`. Nothing heavy ran on the workstation.

Most of this range landed hours earlier through an admin-override merge run, so it had never
been read as one body of work. Five passes, each with its own evidence. A pass that says "looks
fine" without its own artifact is not a pass.

## Verdict

**Ship-able after two fixes**, both of which are in this record with a RED-proven regression.
Neither was found by per-PR CI, and one of them could not have been: it only exists when two
independently-correct changes compose.

## Pass 1 — security boundary (7 credential-touching PRs)

| PR | Verdict |
|---|---|
| #2137 bearer admission | SAFE — narrows substitution. `admission.source === "bearer"` requires an exact match against `OPENCODEX_API_AUTH_TOKEN` or a configured key, so it is not caller-selectable by an unauthenticated party. |
| #2147 xAI OAuth 401 replay | SAFE — refresh is pinned to the rejected snapshot's account, one replay (an `if`, not a loop), refreshed token never logged. |
| #2149 OAuth commit ownership | SAFE — assertion runs under the lock with no `await` before persistence, fails closed, atomic 0600 rename. |
| #2164 OpenCode Go quota | SAFE — the widened predicate still requires exact URL + adapter + key auth, and the fetch ignores the configured URL entirely in favor of a compile-time constant with `redirect: "error"`. |
| #2166 shadow marker | **FINDING, FIXED** — see below. |
| #2146 entitlement discovery | FINDING, recorded not fixed — see "Deliberately left". |
| #2148 baseUrl override | FINDING, recorded not fixed — see "Deliberately left". |

### FIXED — #2166: caller-controlled text reached a durable log

The shadow-call intercept matches by **prefix**, so a caller can send `gpt-5.6-luna` plus
arbitrary trailing text and still be intercepted. The whole raw string was recorded as
`shadowCallRewrittenFrom`, which is persisted to `usage.jsonl` and served from `/api/logs`.

The sanitizer on that path is not sufficient, for two independent reasons — both run against
the shipped code, not reasoned about:

```
"<prefix>\n<Bearer + an sk-shaped value>"    -> control stripped, value redacted
"<prefix>\n<a Google AIza-shaped key>"       -> control stripped, value INTACT
```

(Written as shapes rather than literals on purpose: `scripts/privacy-scan.ts` matches those
patterns wherever they appear, so pasting a real-looking transcript breaks the `gates` job for
every branch cut from `dev`. That is precisely what #2175 had to undo, and this record
reintroduced it — the scanner does not care that a credential is fake.)

1. Control characters are stripped **before** redaction, so the newline that separated marker
   from credential is gone by the time the `Bearer` rule looks for a word boundary.
2. The runtime redactor is a deny-list. An `AIza`-shaped Google key has no rule and survives.

Fix (PR #2170): record the operator-configured prefix that matched, via
`shadowSourceModelPrefix()`. The field can then only hold a value the operator configured.
That removes the class instead of adding one more pattern to a deny-list — which matters,
because the next unrecognized credential family would reopen a pattern-based fix.

RED proof: reverting the two source files fails exactly the two new tests, 15 pass / 2 fail.

## Pass 2 — cross-PR interaction

The shared-contract map found six files touched by 2+ PRs. Three interactions were reproduced;
two were already closed by the time of this audit, one was not.

**Closed already, recorded for the history:** an admission bearer could escape through a
custom-named canonical transport, because #2137 decided substitution from the provider NAME
while the adapter recognized the same row by TRANSPORT. Two predicates answering one question.
Fixed by #2169, verified present at the current `dev` tip.

**FIXED here — `tool_search_call` got the wrong id namespace.** #2145 restores a lowered
tool_search as `tool_search_call` with no id; #2142's universal backfill then names it. The
backfill's prefix table had no entry for the type, so it produced `item_ocx_0`:

```
{"type":"tool_search_call",...}  -> id: "item_ocx_0"
{"type":"function_call",...}     -> id: "fc_ocx_0"
```

Not cosmetic: `stripInvalidItemIds` deletes any id whose prefix does not match its type, and
it lists `tsc_` as the only valid prefix for that type. The id survived the turn that created
it and was silently dropped on the next one, leaving the client an item it could not correlate.
`custom_tool_call` had the identical gap. Fix: PR #2173, with the superset invariant between
the two tables written at the table.

Both PRs' focused suites pass in isolation — neither composes restoration with backfill. This
is the whole argument for a cross-PR pass existing.

**No interaction found**, each with its reason: #2160 static headers × #2148 overrides (neither
overridden provider has static headers); #2160 × #2164 (opencode-go owns no static headers);
#2166 log field × #2147 tier writers (independent fields, no last-writer overwrite); #2151 ×
#2165 (request construction vs request-local parseStream state, no shared lifecycle); #2138 ×
#2145 (canonical-forward vs noncanonical, activation sets do not intersect); #2149 × #2147
(both account- and generation-guarded).

## Pass 3 — default-install wire/behavior regression

**PASS.** Byte-identical on both revisions for: OpenAI-compatible key provider, direct Anthropic
key provider, Google AI Studio, plain native Chat, unsupported caller `service_tier`, caller
reasoning `high`. Verified by SHA-256 over the built request.

Six differences found, every one attributed to an intending PR: AgentRouter framing (#2162,
exact-host gated — a non-AgentRouter Anthropic request is byte-identical), `opencode-free`
static headers (#2160, the only registry row with them), `service_tier: priority` on an exact
Fast-capable model (#2151), `prompt_cache_retention` removal on canonical GPT-5.6 (#2138),
tool_search lowering on noncanonical upstreams (#2145), xAI OAuth Responses routing (#2147).

`shadowCallRewrittenFrom` appears in `usage.jsonl` only when the explicitly-enabled shadow gate
matches; an ordinary request writes the same key set as before.

## Pass 4 — repository invariants

All green on `ssh lidge`: `tests/core-lab-boundary.test.ts` + `tests/repo-hygiene.test.ts`
24 pass / 0 fail; `bun run privacy:scan` passed; `bun x tsc --noEmit` exit 0; no `160000`
gitlink in the tree; no `src/lab/` file changed in the range and every protected core path
stayed transitively Lab-free.

## Pass 5 — release mechanics

Version line `2.27.0` on both `main` and `dev` — coherent, and this campaign did not move it.
No half-finished migration found. No behavior observed that depends on a particular branch
being checked out.

## Deliberately left — not fixed, recorded with the reason

**#2146 — entitlement discovery uses more accounts than the request needs.** An authenticated
`/v1/models`, or any account-gated request, enumerates main plus every pool row with a
syntactically valid id and queries each one's credential concurrently. A request bound to
account B can therefore cause account A's token to be refreshed, persisted, and sent to ChatGPT
discovery. Paused and needs-reauth accounts are not excluded.

Each token stays paired with its own `chatgptAccountId`, so this is not credential
misbinding, and no token reaches a log or the cache (only model sets and SHA-256 fingerprints).
It is excessive credential use with a cross-account side effect. Narrowing the candidate set to
the accounts a request actually needs is a product decision about what `/v1/models` is meant
to enumerate — that is a NEEDS_HUMAN call, not something to infer from the code.

**#2148 — an old config silently activates on upgrade.** `allowBaseUrlOverride` is registry-only
and never persisted, and the router honors any already-saved resolved `baseUrl` the moment the
flag appears. Reproduced:

```
routedProviderConfig("anthropic",          {baseUrl:"https://relay.example.com/v1"})  -> honored
routedProviderConfig("google-antigravity", {baseUrl:"https://relay.example.com/v1"})  -> honored
```

So a custom URL that older releases accepted and ignored starts receiving the OAuth bearer
after upgrade, with no consent step. The transport gate does hold: public cleartext HTTP is
refused for these providers, and URL userinfo is rejected at config validation.

Scope, measured rather than assumed: this range newly opts in exactly **two** providers
(`anthropic`, `google-antigravity`). Thirteen others already had the flag on `main`, so the
upgrade-activation shape is pre-existing behavior, not introduced here. Whether it needs a
persisted consent marker or a release note is a product decision.

**link-local / unspecified addresses under `allowPrivateNetwork`.** `https://169.254.1.1` and
`https://0.0.0.0` are permitted when the flag is set, which reads oddly against the policy
comment. Confirmed **pre-existing**: the classification and the waiver are both unchanged in
this range. Recorded so it is not rediscovered as new, but it is not this release's regression.

## Fixes pushed

| Finding | PR | RED proof |
|---|---|---|
| #2166 caller-controlled marker reaches usage.jsonl and /api/logs | #2170 | 15 pass / 2 fail with the fix reverted |
| tool_search_call / custom_tool_call id namespace | #2173 | 20 pass / 2 fail with the fix reverted |

Full suite at the tip carrying both: **13717 pass / 15 skip / 0 fail** across 866 files;
typecheck exit 0; privacy scan passed. All on `ssh lidge`.


## Closeout — the fixes are on dev

All four landed in dependency order. The order was forced, not chosen: `privacy:scan` runs in
the `gates` job, so while `dev` itself was failing it, every branch cut from `dev` inherited
the failure. #2173 was red for exactly that reason and went green once #2175 landed.

| PR | dev merge commit | What it fixes |
|---|---|---|
| #2175 | `5bcc91d0e` | the broken `privacy:scan` gate on `dev` itself |
| #2170 | `9eb6647d5` | caller-controlled marker reaching `usage.jsonl` and `/api/logs` |
| #2173 | `b2878f8e8` | `tool_search_call` / `custom_tool_call` id namespace |
| #2174 | `12c14d5c3` | this audit record |

Verified at the `dev` tip on `ssh lidge`:

- `bun run test` — **13719 pass / 15 skip / 0 fail** across 866 files.
- `bun x tsc --noEmit` — exit 0.
- `bun run privacy:scan` — passed. It **failed** on `dev` before #2175, which is the whole
  reason that PR exists.
- GitHub CI run `32334852749` — completed **success** at `b2878f8e8`, the commit carrying both
  code fixes. `12c14d5c3` above it is docs-only.
- Fixes present in `dev` source, not just in a merge commit: `shadowSourceModelPrefix` ×1,
  `tool_search_call` ×3.

The three findings under "Deliberately left" are unchanged and still open questions. Nothing in
this closeout resolves them; they need a product decision, not a patch.

Release execution remains unauthorized: no `scripts/release.ts`, no publish, no tag, no change
to `main` or `preview`.
