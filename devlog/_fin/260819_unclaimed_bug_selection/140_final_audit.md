# 140 — final audit of the merged stack, and what it caught

Run after #2116/#2117/#2118/#2121 landed on `dev`. Verdict: **fail**, and the
reason was not one of the four fixes.

## What the audit confirmed

- The proxy-env leak is genuinely dead. The auditor re-ran the five affected
  suites from a clean `git archive origin/dev` — 236 pass / 0 fail — **and then
  re-ran them without `--isolate`**, the exact single-process condition that
  produced the original 73 failures. Still green. That second run is the one
  that matters; the first only proves isolation hides it.
- #2121's gate reason cannot fire on the turn-drain path.
- Escaping holds across all three builders under newline, quote and `%`
  injection.
- Full suite on `dev` head `fbc6f26a2`: **13,501 pass / 0 fail**, run on
  `ssh lidge`.

## What it caught — P1, and it is real

#2107 baked the proxy environment into the installed service definition. A proxy
URL routinely carries `user:password`, so that change quietly made those files
credential-bearing. They were still written with a bare `writeFileSync`.

Measured, not assumed: umask 022, `writeFileSync` with no mode → **0644**.

The precedent was already in the same file and was not followed — the service
API token (`service.ts:387`) and the install state (`:190`) both write
`{ mode: 0o600 }` plus a `chmodSync`. The repo also has an explicit convention
against leaking this exact value: `collectProxyEnv` reports proxy presence as a
boolean so the URL never escapes, pinned by a `doctor` test asserting the
serialized rows never contain `"secret"`.

So the change wrote a credential to a world-readable file in a codebase that
already treats 0600 as the standard for precisely this data.

**The uncomfortable part is procedural.** #2116's own body disclosed the risk
and offered to gate on redaction. That question was never adjudicated — the PR
merged at `REVIEW_REQUIRED` with only bot comments. `AGENTS.md` requires
explicit security review for credential handling. Disclosing a risk in a PR body
is not the same as discharging it, and self-merging past your own open question
is how a known risk becomes a shipped one.

### The fix

One `writeServiceDefinitionFile()` for the plist, the unit, and the Windows
scheduler assets: `{ mode: 0o600 }` plus `chmodSync`, plus the Windows ACL.

The explicit `chmodSync` is not belt-and-braces. `mode` applies only at
creation, so an install over a definition an earlier version left at 0644 would
keep the loose mode — and that is the realistic upgrade path, not a hypothetical.

Red-driven: with the mode argument removed, the three new assertions report
`644` against an expected `600`.

## P2 — the untestable builder was left untested

`buildWindowsServiceScript` was the only one of the three builders with no proxy
assertion, and the reason is instructive: the only way to reach it was to assign
`process.env`, which is the exact pattern whose leak this stack had just removed.
The refactor fixed the leak where a test existed and left the untestable builder
untested.

It now takes the resolved entries like the other two, with a regression covering
the canonical-name rule.

## P2 — the new fix reintroduced the same structural class

`reportedFenceReasons` in #2121 is process-lifetime module state — structurally
the same hazard as the proxy leak, one abstraction away. Whichever file
constructs the error first consumes the one-shot warn, so a later file asserting
on it would see nothing and **pass vacuously**.

Current suites pass in both file orders, so this was latent rather than live. The
reset is now documented as an order-sensitive contract and its caller resets on
both sides.

## P3 — pin-to-line comments were already wrong at merge

`auth-context.ts:326` (actual: 357/363/370), `lifecycle.ts:180`,
`native-profile-startup.ts:138-139` (actual: 142-143) and `:311` (actual: 315).
Replaced with symbol names, which do not drift when a file moves.

## The honest gap that remains

No commit in this stack has a green cross-platform CI run of its own — the runs
were cancelled by successive force-pushes, and `dev`'s own run was still in
flight. Both Windows-specific behaviors this stack shipped are unverified on
Windows: the Windows proxy path had no test until now, and `owner-unavailable` —
the branch #2108 most needs named — is a Windows icacls path asserted nowhere in
the suite.

Stating it rather than filing it as done.

## The lesson worth keeping

An audit that only re-runs what the author ran finds nothing. This one found the
P1 by asking a question the author never asked — *what mode is that file?* — and
then measuring it instead of reasoning about it.

