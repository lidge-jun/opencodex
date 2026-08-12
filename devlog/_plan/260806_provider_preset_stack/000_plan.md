# 000 — Provider preset stack under umbrella issue #572

Unit owner: maintainer (lidge-jun). Opened 2026-08-06.
Loop: HOTL goal `land-the-four-open-provider-preset-prs-under-umb`, PABCD per work-phase.

## Objective

Land the four open provider-preset pull requests in dependency order and reach a
defensible terminal disposition for each:

| WP | PR | Providers | Head |
| --- | --- | --- | --- |
| WP1 | #870 | SambaNova Cloud, Nebius Token Factory | `olddonkey:codex/572-sambanova-nebius-model-apis` |
| WP2 | #872 | DigitalOcean Serverless Inference, Scaleway Generative APIs | `olddonkey:codex/572-digitalocean-scaleway-model-apis` |
| WP3 | #937 | Nscale, Vultr Serverless Inference | `olddonkey:codex/572-nscale-vultr-model-apis` |
| WP4 | #812 | Apertis | `theQuert:codex/apertis-provider` |

All four report `maintainerCanModify=true`, so the maintainer may rebase and
force-with-lease push each contributor branch directly.

## Why this ordering (PHASE-SPLIT-01, dependency not effort)

The three `olddonkey` PRs are not independent: each one edits the SAME lines of
`src/providers/registry.ts` (the `EXPECTED_KEY_PROVIDER_IDS` array and the
preset table), `tests/provider-registry-parity.test.ts`, and the five locale
copies of `providers.md` / `quickstart.md` that state the preset totals. The
author sequenced them himself: #872 is "Draft until #870 lands", #937 is "Draft
behind #870 and #872". Landing them out of order guarantees a second conflict
resolution on the same lines.

WP4 is last because it is not a rebase problem — it is an evidence problem. Its
registry diff is small (14 lines), but the reviewer's blocker is that public
terms of service do not establish third-party routing authorization. That gate
is resolved by research, not by git.

## Ground truth measured on `origin/dev` (2026-08-06)

`origin/dev` at `ef1317871`. Registry counted by executing the module, not by
reading prose:

```
bun -e 'const {PROVIDER_REGISTRY}=await import("./src/providers/registry.ts"); ...'
total 70 { forward: 1, oauth: 8, key: 58, local: 3 }
```

Branch drift against `origin/dev` (`git rev-list --left-right --count`):

| PR | dev ahead | branch ahead | unique commits |
| --- | --- | --- | --- |
| #870 | 418 | 2 | `cc73144ad`, `59d551c0a` |
| #872 | 760 | 2 | `8a14260d9`, `fc7222f78` |
| #937 | 760 | 1 | `d717f77e7` |
| #812 | 528 | 3 | `63301e50a`, `477609159`, `a1dcde8cb` |

## The count contract (the single largest correctness risk)

Every one of these PRs edits a human-written sentence that claims a preset
total, in five languages, in two files per language. Those sentences drifted
while the branches sat:

- English `quickstart.md` says **70**; #870 rebases from a base that said 69 and
  rewrites it to 71.
- English `providers.md` says `70 built-in presets: 58 key-based, **eight**
  OAuth, three local, and one default` — but #870's diff writes `71 built-in
  presets: 60 key-based, **seven** OAuth`. The OAuth number in the incoming diff
  is stale: dev has 8, not 7. A naive `git rebase` that takes "theirs" would
  silently regress a correct number.
- The Korean locale carries the same regression (`OAuth 8` -> `OAuth 7`).

**Rule for every work-phase in this unit:** the totals are never copied from the
PR body or from the incoming diff. After each rebase, re-run the registry count
program, and write the measured numbers into all ten locale sentences plus the
parity test. The PR body's claimed total is treated as an unverified assertion.

### Amendment A1 (audit round 1, High) — the OAuth narrative is a THIRD count site

The independent audit found the regeneration list incomplete. Beyond the ten
total sentences, each locale's `providers.md` opens section 2 with a SECOND,
independent count:

> "Six provider presets use OAuth login — plus GitHub Copilot via an
> experimental unofficial device-flow bridge."
> — `docs-site/src/content/docs/guides/providers.md:92`, and the `ja`/`ko`/`ru`/
> `zh-cn` equivalents.

That sentence is **already wrong on dev**, before any of these PRs. Measured:

```
oauth: cursor, xai, command-code, anthropic, kimi, kiro, google-antigravity, github-copilot
```

Eight rows. The prose says six-plus-Copilot (seven). `command-code` landed as an
OAuth preset and its narrative was never updated.

This is a pre-existing docs defect, not one these PRs introduce, but it sits in
the exact sentences this unit rewrites and the count-regeneration contract is
meaningless if it leaves a neighbouring count wrong. Fold the correction into
WP1: state **seven** normal OAuth presets plus the experimental Copilot bridge,
in all five locales, and check whether the section's login-command examples list
`ocx login command-code`.

Regeneration checklist per work-phase, corrected to three site classes:

1. `quickstart.md` x5 — "choose one of the N built-in registry presets"
2. `providers.md` x5 — "ships N built-in presets: K key-based, O OAuth, L local, one default"
3. `providers.md` x5 section 2 — the OAuth-count narrative and its command examples

### Amendment A2 (audit round 1, High) — scope boundary vs. WP1's real change

The scope boundary below excludes "model-discovery core contracts", while WP1
demonstrably lands a rewrite of `resolveProviderModelDiscovery`. The audit is
right that this is a contradiction, and the honest resolution is to widen the
boundary rather than pretend the change is not there.

**Corrected boundary:** the `resolveProviderModelDiscovery` destination-fallback
in PR #870 is IN SCOPE and is the single highest-risk hunk in this unit. It ships
only if WP1's C phase demonstrates, with a test that actually fires:

- a renamed canonical preset (exact fixed-key `baseUrl` + adapter) recovers its
  discovery spec;
- a row whose NAME matches a registry entry but whose transport does not still
  gets `undefined`;
- OAuth rows, forward/local rows, template destinations, and overridable
  destinations are all refused.

No OTHER model-discovery contract may change in this unit.

### Amendment A3 (audit round 1, Medium) — measured conflict surface replaces the prediction

The auditor performed a real detached rebase of `refs/tmp/pr870` onto
`origin/dev` in a throwaway `/tmp` worktree. Observed: **exactly ten textual
conflicts, all documentation** — the five `quickstart.md` and five
`providers.md` locale files. `registry.ts`, `provider-registry-parity.test.ts`,
`model-discovery.ts`, `provider-fetch.ts`, and `free-directory.ts` all applied
cleanly.

That inverts the risk model. The per-PR conflict tables in `010`/`020`/`030` are
predictions and are superseded by what each rebase actually reports. The code
merges itself; the danger is entirely in the prose counts, which git will
happily let us resolve wrongly. Treat every documentation conflict as
"regenerate from the measured registry", never as "take one side".

### Amendment A4 (audit round 1, Medium) — parity test has more than one expectation

`tests/provider-registry-parity.test.ts` asserts more than the key-id list:

- `registry ids are unique` (line 42)
- `Object.keys(KEY_LOGIN_PROVIDERS)` must **deep-equal** `EXPECTED_KEY_PROVIDER_IDS`
  — order-sensitive, so a new id must be inserted at the position matching its
  registry position (line ~47)
- an exact `freeTier` provider list (line ~465), measured today as
  `nvidia, cloudflare-workers-ai`

WP2 adds `scaleway` with `freeTier: true`, so the `freeTier` expectation must
grow to three ids. The PR already does this; the point is that the verification
step must confirm it rather than assume the key-id list is the only expectation.

### Amendment A5 (audit rounds 1-2) — absolute `spec.url` inventory, measured

`010` originally claimed a discovery spec "only shapes the discovery request
against the provider's own configured `baseUrl`". An absolute `spec.url` in a
registry entry overrides the configured base (`model-discovery.ts:160`), so that
claim was too strong.

Round 1 replaced it with "confirm no fallback-eligible entry carries an absolute
`spec.url`". Round 2 correctly showed that gate is **already false** and would
fail on merge. Full inventory, measured by executing the registry:

| entry | absolute `spec.url` | fallback-eligible? | base origin | spec origin | same origin? |
| --- | --- | --- | --- | --- | --- |
| `command-code` | `https://api.commandcode.ai/provider/v1/models` | **no** (`authKind: "oauth"`) | api.commandcode.ai | api.commandcode.ai | yes |
| `deepinfra` | `https://api.deepinfra.com/v1/models` | **yes** | api.deepinfra.com | api.deepinfra.com | yes |

`deepinfra` is the only fallback-eligible entry with an absolute URL, and its
discovery origin is **identical to its own base origin**. The reachable behavior
is therefore: a custom provider configured at
`https://api.deepinfra.com/v1/openai` with the `openai-chat` adapter, saved
under any name, now discovers models at `https://api.deepinfra.com/v1/models`.
The user's key travels to the origin the user themselves configured. No
cross-origin destination is reachable through the fallback today.

**Corrected gate.** Do not require "no absolute URL". Require:

1. every fallback-eligible entry with an absolute `spec.url` is **same-origin**
   with its own `baseUrl`;
2. a regression assertion pins that invariant, so a future entry cannot
   introduce a cross-origin discovery URL reachable by destination fallback
   without failing a test.

That assertion does not exist today and is a WP1 deliverable, not a check.

### Amendment A6 (audit round 2, High) — WP1 must ADD tests, not "confirm" them

Round 1's activation-grounding section told WP1 to confirm that
`tests/provider-model-discovery-contract.test.ts` covers three branches of the
destination fallback. Round 2 read the actual test file on `refs/tmp/pr870` and
found the coverage is not there:

- the renamed-row test proves only that a renamed Together row picks up a
  path/query (`:123`); it makes **no filter assertion**;
- `:111` merely enumerates eligible fixed-key rows;
- the OAuth tests at `:166` are named-provider pinning, **not** unknown-name
  destination fallback.

No negative tests for the excluded classes exist. The C-phase requirement as
written demanded evidence that does not exist, which would have produced either
a false pass or a late blocker.

**WP1 therefore SCHEDULES these test additions as build work:**

1. positive: renamed canonical preset recovers path, query **and filter**;
2. negative: name matches a registry entry but transport does not -> `undefined`;
3. negative: OAuth row not reachable by unknown-name destination fallback;
4. negative: forward/local rows, `{template}` base URLs, and
   `allowBaseUrlOverride` rows all refused;
5. invariant: every fallback-eligible absolute `spec.url` is same-origin with its
   entry's `baseUrl` (Amendment A5).

Each is driven red once before being accepted, per the repo's own
non-vacuous-guard convention.

### Amendment A7 (audit round 2, Medium) — A1 execution is mandatory, not discretionary

A1 said to "check whether" the OAuth section's command examples list
`ocx login command-code`. Measured: it is **absent** from the English command
list at `docs-site/src/content/docs/guides/providers.md:97`. The check is
answered; the edit is mandatory in all five locales.

The count read-back at the end of each work-phase is mechanical over **15 sites**:
5 quickstart totals, 5 `providers.md` totals, 5 OAuth narratives — plus the
parity `freeTier` array after WP2.

Scope-creep counterargument, recorded because it is the strongest case against
folding this in: correcting a pre-existing Command Code documentation defect
expands a provider PR into five locale command/table edits unrelated to
SambaNova or Nebius. It stays folded because it is the same five conflicted
files and the same contract — but it is named explicitly in the merge commit so
it is not a silent rider.

### Amendment A8 (audit round 2) — WP2/WP3 prediction tables are superseded

The conflict tables in `020` and `030` remain predictions. Per A3 they are
superseded by whatever each rebase actually reports; treat the measured output
as authority and do not act on the predicted table.

Expected totals as each work-phase lands (key = dev 58 + 2 per PR; oauth/local/
forward unchanged):

| After | total | key | oauth | local | forward |
| --- | --- | --- | --- | --- | --- |
| dev today | 70 | 58 | 8 | 3 | 1 |
| WP1 (#870) | 72 | 60 | 8 | 3 | 1 |
| WP2 (#872) | 74 | 62 | 8 | 3 | 1 |
| WP3 (#937) | 76 | 64 | 8 | 3 | 1 |
| WP4 (#812) if merged | 77 | 65 | 8 | 3 | 1 |

These are predictions to be re-measured, not values to be pasted.

## Acceptance criteria (per merged PR)

1. Rebased onto the then-current `origin/dev`, no conflict markers,
   `git diff --check` clean.
2. `bun run typecheck` exits 0.
3. The PR's own provider test file plus `tests/provider-registry-parity.test.ts`
   plus `tests/provider-model-discovery-contract.test.ts` pass.
4. `bun run privacy:scan` exits 0.
5. Totals in registry, parity test, and all five locales agree with the measured
   registry count.
6. The PR's evidence table still resolves against the code: base URL, auth
   scheme, and tool-model allowlist match what the diff actually implements.
7. Merged into `dev`, confirmed live via `gh`.

## Scope boundary

IN: rebase/conflict resolution on the four head branches; total regeneration;
the fixtures and per-provider tests already in each PR; force-with-lease push to
the contributor forks; merge into `dev`; this devlog unit.

OUT: adapter semantics, model-discovery contracts OTHER than the #870
destination-fallback admitted by Amendment A2, any other open PR,
bug-labeled PRs, promotion to `main`/`preview`, releases, `.github` workflows.
Per `AGENTS.md`, no security finding is written into this directory.

## Maintainer security review

`MAINTAINERS.md` requires explicit maintainer security review for new credential
destinations, and each of these PRs requests it. The maintainer authorized this
batch directly in-session on 2026-08-06. The review is therefore recorded here
and performed per work-phase against the actual diff — base URL, Bearer
transport, redirect refusal, `preserveCustomDestination`, and the promise that
registry-only discovery policy is never serialized into `config.json`.

## Documents in this unit

- `010_wp1_pr870.md` — SambaNova + Nebius
- `020_wp2_pr872.md` — DigitalOcean + Scaleway
- `030_wp3_pr937.md` — Nscale + Vultr
- `040_wp4_pr812.md` — Apertis evidence gate and both dispositions
