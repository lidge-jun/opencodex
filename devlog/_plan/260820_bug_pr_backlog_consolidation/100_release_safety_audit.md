# 100 — Release-safety audit of `main..dev`

Unit: 260820_bug_pr_backlog_consolidation
Range audited: `origin/main` `8e01dd4e8` → `origin/dev`, 92 commits / 22 merges / 109 files.

Most of this range landed in one admin-override merge run hours earlier. It had never been
read as a single body of work, which is the only reason this audit is worth its cost: a merge
run answers "does each PR pass" and this answers "is the result shippable".

Four passes, four read-only lanes plus direct verification in the main agent. Every finding
below was reproduced before it was fixed; nothing was patched on a lane's word alone.

## 1. Security boundary — ONE REAL LEAK, FIXED

**An admission bearer reached ChatGPT.** `#2169`.

Two predicates were answering one security question with different inputs:

| Question | Predicate | Keyed on |
|---|---|---|
| "must we substitute the stored credential?" | `route.codexAccountMode !== undefined` | provider **name** |
| "may we forward the caller's Authorization?" | `isCanonicalOpenAiForwardProvider` | adapter + authMode + **base URL** |

A provider row named anything other than `openai`, pointed at the canonical ChatGPT backend
with `authMode: "forward"`, satisfies the second and fails the first. Substitution was skipped
and the adapter forwarded our own proxy secret. Reproduced through the real adapter:

```
URL:  https://chatgpt.com/backend-api/codex/responses
AUTH: Bearer <the proxy's own admission secret, verbatim>
LEAKED: true
```

This violates the contract stated in `src/codex/auth-context.ts`: an admission bearer is
replaced with the stored main credential or the request fails before any I/O. Substitution now
consults the same authority the adapter does.

Worth recording how nearly this was missed: **two of three lanes classified #2137 SOUND.** One
of them read `openai-responses.ts:1451` and concluded "only the canonical ChatGPT destination
may relay caller credentials" — true, and exactly the problem, because canonical-ness is
decided by URL while substitution was decided by name. A correct observation, a wrong verdict.
The majority was wrong and the minority had a reproduction; the reproduction won.

**Recorded, deliberately not patched:** #2148 lets an OAuth bearer reach any operator-configured
HTTPS host, with no vendor allowlist. Both lanes agree this is operator authorization by
definition and it is the stated point of the PR. It is a WEAKENED-by-design boundary, not a
defect, and narrowing it is a product decision rather than an audit fix.

## 2. Cross-PR interaction — PASS

The merge run already proved this defect class exists here (the id backfill mutated the compact
endpoint's wire format; neither branch failed alone). A dedicated hunt over 21 same-file overlap
pairs plus cross-file wire/predicate overlaps found no second instance. 366 pass / 0 fail across
13 composed files.

## 3. Default-install behavior — PASS

Every ungated change traces to the fix that intended it. Specifically checked, because these
were the plausible accidents:

- AgentRouter framing fires only for `agentrouter.org` and its real subdomains.
- `opencode-free` is the only registry row with `staticHeaders`, so no other provider's headers moved.
- The shell hook now installs **less** often than before, not more — it is gated on an installed CLI.
- The tool-catalog nudge is byte-identical in this range.

One documented side effect: #2146's cold entitlement lookup adds an authenticated `/models`
fetch during catalog sync. Bounded, fail-closed, and no credentials means no fetch.

## 4. Repository invariants — PASS, with TWO GUARD DEFECTS FIXED

The invariants themselves hold: core reaches no Lab path from any of the three protected roots
(192 / 101 / 344 modules walked, dynamic edges followed), zero gitlinks, zero vendored clones,
privacy signature scan clean.

But two of the mechanisms we rely on were quietly broken. `#2171`.

**The core/Lab guard had a directory bypass.** It matched only `/lab/`, and `src/lab/index.ts`
exists — so `import("../lab")` resolves to the Lab entrypoint and matched nothing:

```
source          : void import("../lab");
Guard 1 detects : false
```

The self-test that claims to protect the guard re-declared its own copy of the regex. A copy
cannot fail when the original drifts, which is precisely how a guard rots while looking green.
Both now call one shared predicate.

**The release helper's documented path could never complete.** A dry run bumps, commits, and
pushes deliberately, so the `--publish` re-run it instructs you to do hits
`npm version <same-version>` and exits `Version not changed` before dispatching. The bump and
push are now a desired end state rather than mandatory actions.

Neither defect came from this range. Both would have been trusted by the next release.

## Contributor PR merged during the audit

`#2167` (@ntdatt812) — a background `/wham/usage` 200 was retracting a reauth quarantine that
Responses traffic had set. A 200 from the usage endpoint proves the token authenticates *there*;
it does not prove the account can serve Responses, which still answers 403 for a workspace the
token can no longer select. The account went straight back into rotation, failed identically,
and re-quarantined — so `needsReauth` never settled. Correct diagnosis, correct fix, and it
pins both directions.

## Coverage limits, stated rather than implied

`privacy:scan` is a **signature** scan. It detects `/Users/<name>/` paths, email shapes, long
`Bearer` literals, and selected `sk-`/`ghp_`/JWT forms in tracked text files. It does not see
`/home/...` paths, arbitrary key prefixes, short secrets, runtime dataflow, `usage.jsonl`
contents, or whether a new log field carries PII at runtime. A green scan is evidence about
literals in the tree, not about behavior.

## Verdict

The range is shippable **after** #2169. Before it, a specific configuration leaked a proxy
credential to a third party, and no test would have caught it.

Version line on `dev` is `2.27.0`, equal to the published `latest` and the `v2.27.0` tag on
`main` — the release helper takes the next version as an argument, so this is the expected
pre-release state, not a half-finished bump.

This remains a readiness record. No release was executed.
