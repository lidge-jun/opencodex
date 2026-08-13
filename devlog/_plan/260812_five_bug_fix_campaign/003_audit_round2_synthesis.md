# 003 — Audit round 2: synthesis and final amendments

Same reviewer, re-audit after the round-1 amendments. Verdict: **FAIL**, 5
remaining blockers. Anchor moved to `origin/dev af2ed77d8` (one CI-only commit
on top of `cbbfdd877`; no source drift in the files this unit touches).

Round-1 blockers B2, B3, B4, B5, B6, B7, B11 and the evidence half of B12 are
confirmed closed. Both of my rebuttals (B1 semantics, B9 uniformity) were
accepted with line evidence. Five findings remain, and **four of them are real
defects in my amendments** — including one that would have shipped a test that
could never pass.

## R2-1 (High) — the `contextWindow` carry-over I added cannot execute

**Verified, and this one is decisive.** My amendment proposed:

```ts
if (existingContextWindow !== undefined && prov.contextWindow === undefined) { ... }
```

But `enrichProviderFromCatalog(name, prov)` runs **before** that line
(`provider-routes.ts:353`), and `derive.ts:404` already did:

```ts
if (prov.contextWindow === undefined && seed.contextWindow !== undefined) prov.contextWindow = seed.contextWindow;
```

So by the time my guard runs, `prov.contextWindow` is the registry seed, never
`undefined`. The guard is dead code and its acceptance test would have stayed
red.

This is the same trap the `modelContextWindows` fix avoids only by accident: my
map version merges `{...existing, ...(prov.x ?? {})}` unconditionally, so it
works — but it would *also* merge registry-seeded keys into the stored row,
which is the behavior we already have and is not harmful for a fill-only map.
The scalar has no such luck.

**Amendment.** Capture request ownership **before** enrichment, for every
carried field:

```ts
// Ownership must be sampled BEFORE enrichProviderFromCatalog: enrichment fills
// absent fields from the registry seed, after which "the client omitted this"
// is indistinguishable from "the registry supplied it" (audit R2-1).
const submittedContextWindow = Object.hasOwn(prov, "contextWindow");
const submittedModelContextWindows = Object.hasOwn(prov, "modelContextWindows");
enrichProviderFromCatalog(name, prov);
...
const existing = config.providers[name];
if (!submittedContextWindow && existing?.contextWindow !== undefined) {
  prov.contextWindow = existing.contextWindow;
}
if (existing?.modelContextWindows) {
  prov.modelContextWindows = submittedModelContextWindows
    ? { ...existing.modelContextWindows, ...(prov.modelContextWindows ?? {}) }
    : { ...existing.modelContextWindows };
}
```

Note the second branch also fixes a latent flaw in my round-1 map fix: when the
client omitted the map, the stored value should be the user's map, not the
user's map with registry seeds merged in.

This pattern — sample ownership pre-enrichment — is the correct general shape
for every field in the ownership matrix, so `040` states it once as the rule.

## R2-2 (Medium) — `020`'s fallback snippet contradicts the accepted decision

**Verified.** The reviewer confirmed my B1 reading (the flag drives only
heartbeat suppression at `google.ts:676-689`), but my independent-implementation
fallback snippet still contained `if (textEvent.type === "text_delta") emittedContentEvent = true;`
— the behavior the amended prose now calls wrong.

**Amendment:** the fallback sets the flag for every emitted event, and the two
required tests (heartbeat classification, signature replay) move into the
numbered acceptance criteria instead of living only in prose.

## R2-3 (Medium) — `retainedWindow*` has two different populations

**Verified.** `summarizeUsage` filters by range **and** surface
(`summary.ts:706-716`) *after* the byte-bounded read. My `031` described the
fields as spanning "summarized rows" in one place and rows that "actually fit"
the reader in another. Those are different sets, and publishing the wrong one
next to a summary would be a new small lie of exactly the kind #1497 is about.

**Amendment:** rename to `snapshotWindowStart` / `snapshotWindowEnd`, defined
unambiguously as min/max timestamp across `snapshot.entries` — the rows the
reader loaded, before range/surface filtering — and label them that way in the
API and the UI. This is the honest, cheap contract: it describes what was read,
which is exactly the thing truncation affects. Tests cover an empty snapshot and
a surface-filtered request to pin that the fields do not track the filtered set.

## R2-4 (Medium) — `!name` is not "nonblank", and existing test T7 expects the old behavior

**Verified, both halves.**

`tests/openai-chat-parallel-stream.test.ts:144` is literally titled
*"T7: name never arrives - call still flushed with empty name (parity, no silent
drop)"* and asserts `{ id: "anon", name: "", args: "{\"q\":1}" }`. My plan would
have added a new test while leaving this one red — and worse, T7 encodes a
deliberate past decision, so changing it needs to be an explicit, argued change
rather than a casualty.

The argument for changing it: T7's rationale is "no silent drop", and the new
behavior is not a silent drop — it is a loud, terminal error. The invariant T7
protects (a claimed call never vanishes without a trace) is preserved and
strengthened; only the mechanism changes from "emit unusable" to "fail the
turn". That is the reasoning recorded in the PR.

`!name` also admits `"   "`. **Amendment:** both paths validate
`name.trim().length > 0`, and `010` explicitly updates T7 (retitled to reflect
the terminal-error contract) while keeping T6's late-name coverage untouched.

## R2-5 (Medium) — the `051` audit table could disclose an unshipped finding

**Verified against `AGENTS.md`.** The repository rule is explicit: unreleased
failure findings and pre-disclosure patch reasoning stay in scratch (`.tmp/`),
never in a public comment or `devlog/`. My `051` listed "the complete audit
table" as a public issue-comment deliverable, which would publish an unguarded
body-settlement path before its fix ships.

**Amendment:** `051` orders it explicitly — publish only protections that are
already shipped and public; any newly discovered unguarded site stays in `.tmp/`
until its fix is merged, and only then is it named in the issue.

## Status

All five are amended below/in the phase docs. Round 3 re-audit follows; the
plan is not implemented until it passes.
