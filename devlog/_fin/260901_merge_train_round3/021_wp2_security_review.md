# 021 — wp2 security review: #3122 passed, and what the review actually established

Reviewer: `gpt-5.6-sol`/high, independent read-only lane. `VERDICT: PASS`, zero blockers.

`020` called this change mechanical. It is not — it is a caller of
`src/lib/destination-policy.ts`, the SSRF/destination guard, so `AGENTS.md`'s
"Security boundary (highest priority)" applies. The escalation was recorded at P and the
A phase dispatched a reviewer instead of the maintainer read that sufficed for wp1's
docs-only unit.

## The question that mattered

The packet's highest-value question was whether `next` is a **partial field mask** or the
**merged provider**. If partial, an attacker could PATCH a subset of fields so that
`isCanonicalOpenAiForwardProvider(next)` returns true while the effective stored provider
is not canonical — an escalation the POST path does not have.

It is merged, and the code says so twice:

```
src/server/management/provider-routes.ts:114-121
  const next: OcxProviderConfig = { ...provider };

src/server/management/provider-routes.ts:737-739  (the route's own comment)
  // Field-mask editor: apply recognized fields onto a copy, then validate the MERGED
  // provider (canonical-seed guard covers openai; ...)
```

I verified this myself before accepting the reviewer's answer, which is the point of
asking a question whose answer is checkable in one file.

The three predicate fields (`adapter`, `authMode`, `baseUrl`) *are* PATCH-writable
(`:133-161`), so the predicate is attacker-influenced — but influencing it requires making
the effective provider genuinely canonical, and the merged object must clear canonical seed
validation at `src/server/auth-cors.ts:560-593` before the DNS probe runs. Gaining the
exception and being the provider the exception exists for are the same act.

## Blast radius

The exception admits only DNS answers in `198.18.0.0/15`
(`src/lib/destination-policy.ts:49-68`), in three wrapped forms: IPv4-mapped
(`:155-167`), NAT64 `64:ff9b::/96` with a benchmark embedded quad (`:169-181`), and the
explicit-zero `::ffff:0:<IPv4>` spelling, again only when the embedded address is itself
benchmark space (`:125-145`).

Everything dangerous stays closed, and the mechanism is one line:

```
src/lib/destination-policy.ts:339-349
  if (options?.allowBenchmarkAddresses && isBenchmarkDnsAnswer(address, assessment)) {
    continue;
  }
  if (assessment.kind === "metadata") return `... blocked metadata endpoint ...`;
  return `... resolves to a ${assessment.detail} ...`;
```

The loop skips **individual** benchmark answers; every other non-public answer misses the
`continue` and returns an error immediately. So loopback (`:54`), RFC1918 and CGNAT
(`:55-56`), metadata `169.254.169.254` (`:12-16`), IPv6 loopback/private/link-local
(`:183-199`), and any mixed answer set all still fail closed with the flag on. Literal
benchmark URLs also stay refused, because synchronous validation runs before DNS handling
(`:321-330`) and the exception is consulted only for resolved answers.

## What makes this landable rather than merely plausible

The tests catch **both** boolean mutations, which is the difference between a test that
documents a flag and one that pins it:

| mutation | fails |
| --- | --- |
| flag hardcoded `true` | `PATCH destination benchmark exception stays scoped to the canonical openai row` (`:2508-2566`) |
| flag hardcoded `false` | `canonical OpenAI PATCH passes allowBenchmarkAddresses into destination resolution` (`:2465-2506`) and `canonical OpenAI PATCH still rejects non-benchmark private destination answers` (`:2569-2606`) |

A guard whose tests only catch one direction is a guard that can silently widen.

## Corrections to `020`

- `020` cited `:512-513` as the POST path. It is the provider **reload** path; POST is
  `:588-589`. Both carry the same guard, so the substance — that PATCH was the odd one out
  — is unchanged.
- The reviewer notes that passing `{ allowBenchmarkAddresses: false }` is behaviourally
  identical to omitting the option, since the policy branches only on a truthy flag
  (`:339-345`). Nothing to fix; worth knowing before someone "simplifies" the call.

## Carry

Cherry-picked as `4a3b4235b` onto `origin/dev` = `abcda8e13`, authorship preserved:

```
4a3b4235b Flowershangfromthebranches <152056395+Flowershangfromthebranches@users.noreply.github.com>
```

Focused verification on the carry:
`bun test tests/management-provider-validation.test.ts tests/destination-policy-resolved.test.ts`
-> 129 pass / 0 fail / 635 expect().
