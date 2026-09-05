# 020 — Phase 2: `--bump`, with channel-specific algebra

`scripts/release.ts` accepts `--bump patch|minor|major` as an alternative to a typed
version string. The resolved version `X` then flows exactly where the typed string
went: same guards, same commit, same dispatch.

Depends on: `010`. Independent of `030`.

## 1. Scope

The helper still commits `X` to `package.json`, still commits `release: vX`, and
still dispatches `version=X` with no additional input. This phase adds an input
*spelling*, not a new release layout.

## 2. File change map

| Path | Action |
|---|---|
| `scripts/version-line.ts` | MODIFY — add the channel-specific resolvers (§4) |
| `scripts/release.ts` | MODIFY — argument parsing (§3) |
| `tests/version-line.test.ts` | MODIFY — resolver cases (§6) |
| `tests/release-helper.test.ts` | MODIFY — CLI cases (§7) |
| `docs-site/src/content/docs/contributing.md` (+7 locales) | MODIFY — document `--bump` |

`scripts/version-line.ts` and `tests/version-line.test.ts` are created by `010` and
extended here.

## 3. Argument resolution

Replaces `scripts/release.ts:487-491`. The typed form is unchanged; the new branch
resolves `X` from a bump kind.

```
// --bump and an explicit version are mutually exclusive; exactly one is required.
// Kind is validated before any network call.
//
// Channel-specific: a stable bump and a preview bump do NOT share a base, and both
// resolvers take the full tag/channel picture. See §4.
const version = explicit ?? (tag === "preview"
  ? nextPreviewRelease({
      kind: bumpKind!,
      stableTip, stableTags,
      previewTip, previewTags,
      stamp: utcStamp(),
    })
  : nextStableRelease({
      kind: bumpKind!,
      stableTip, stableTags,
      previewTags,        // needed for the §4.0 refusal check
    }));
```

Resolution must sit **after** the branch gate (`scripts/release.ts:494-511`) so
`tag` is known and a wrong-branch invocation aborts before any network call, and
after `packageName` (`:513`). Tags come from `git tag --list 'v*'`, partitioned into
stable and preview by `parseVersion`; the two channel tips come from the single
`npm view <pkg> dist-tags --json` call the script already makes at `:343`.

## 4. Channel-specific algebra

### 4.0 The cross-channel ordering contract — READ FIRST

**Contract (i), chosen: ordering stays global, and publishing a higher-core preview
CLOSES older stable patch lines. This is a deliberate release-policy RESTRICTION,
not the preservation of an unused capability.**

Stated first because every resolver below depends on it. Probed against the real
comparator in this repository:

```
compareReleaseTags("v2.42.1", "v2.43.0-preview.1") = -1
compareReleaseTags("v2.43.1", "v2.44.0-preview.1") = -1
compareReleaseTags("v2.42.1", "v2.42.0-preview.9") =  1
```

A prerelease of a **higher core** outranks a stable **lower** core. So once
`v2.43.0-preview.1` is tagged, `2.42.1` is below the highest tag, and two things
reject it: the global-floor assertion in §4.4, and
`tests/release-version-line.test.ts:88-120` — **unchanged by this unit** — which
would reject the resulting release commit as behind the highest tag.

**Therefore a `patch` bump is refused when a preview tag exists for a core above the
base.** The resolver raises an explanatory error instead of returning a version that
cannot be released. In plain terms: **opening a preview for `2.43.0` ends the
`2.42.x` patch line.** A fix after that point ships as part of `2.43.0`.

#### What this gives up — measured, not assumed

An earlier draft of this document claimed the capability was essentially unused,
"apart from `v2.32.1`". **That claim was false and is retracted.** The measurements:

- **103 of 143 stable tags have `patch > 0`** (`git tag --list 'v*'`, prereleases
  excluded). Patch releases are the historical norm, not an exception.
- The exact pattern this policy forbids — a **lower stable patch published AFTER a
  higher-core preview** — has happened at least three times, verified by commit
  timestamp:

| higher-core preview | then a lower stable patch |
|---|---|
| `v2.6.24-preview.20260705` @ 2026-07-05 18:04:58 | `v2.6.23` @ 2026-07-05 19:40:28 |
| `v2.6.26-preview.20260705` @ 2026-07-05 20:15:33 | `v2.6.24` @ 2026-07-05 20:15:40 |
| `v2.7.39-preview.20260724` @ 2026-07-24 15:12:26 | `v2.7.37` @ 2026-07-24 15:23:24 |

These counterexamples are kept in the plan deliberately, so nobody re-derives the
retracted "unused capability" claim from a fresh look at recent history.

#### The actual rationale

Three things, none of which is "nobody used it":

1. **The current global invariant already disallows it.**
   `tests/release-version-line.test.ts:88-120` refuses any tree behind the highest
   tag, with no channel awareness. The three rows above predate that test's current
   form. This plan does not impose a new restriction; it makes an existing one
   **explicit and legible at the point of use**, instead of letting a maintainer
   discover it from a confusing failure two steps later.
2. **Recent trains have converged on `.0` stable releases.** The last patch release
   is `v2.32.1` (2026-08-25); every release since has been `X.Y.0`. The restriction
   binds a workflow the repository is not currently using, even though it certainly
   used it before.
3. **The alternative weakens the unit's central guard.** (ii) requires the invariant
   itself to become channel-aware, i.e. changing the one file this unit has been
   careful not to weaken — the rule that makes a stale `dev` detectable at all.

So the honest framing: this is a **policy decision to keep the invariant simple**,
paid for with a capability the repository exercised in the past and has not
exercised recently. It is not free, and a maintainer who wants patch lines back
should read §4.0a rather than assume nothing was lost.

#### 4.0a If patch lines must be reopened

That is contract (ii), and it is a separate unit: the invariant becomes
channel/branch-aware, `tests/release-version-line.test.ts` changes with it, and the
release-note baseline selection (`scripts/build-release-changelog.ts:129-141`) needs
re-examination because it currently filters candidates by global ordering too.
Changing only the bump resolver is insufficient — that was this document's round-3
error and it is recorded here so the next attempt starts from the right scope.

If a stable patch line ever genuinely must survive an open preview, that is a
separate unit per §4.0a, argued on its own evidence.

#### Enforcement lives at the publication boundary, not here

The resolver's refusal is **advisory**: it only fires when a maintainer uses
`--bump`. A stable patch SHA that passed CI *before* a higher-core preview was
tagged can still be dispatched manually afterwards, bypassing this function
entirely. `030` §5a adds the real gate in `release.yml`, after the fresh tag fetch.
A policy only the happy path honours is not a policy.

### 4.1 Why a single floor is wrong

A single `max(tags ∪ channel)` floor produces three concrete failures:

1. `latest=2.42.0` with an existing `v2.43.0-preview.1` makes the global floor the
   preview, so `--bump minor` yields **2.44.0** and skips the intended 2.43.0.
2. From floor `2.42.0`, `--bump minor` gives `2.43.0`; feeding that to a successor
   required to return something strictly greater **cannot** produce
   `2.43.0-preview.*`, because a prerelease ranks *below* its own stable core.
3. A stable bump computed from a global floor lands on a future preview core, which
   is not a stable version at all.

So the channels get separate functions with separate bases.

### 4.2 The resolvers

```ts
/**
 * The next STABLE release. Base is the stable line only: the newest of the 'latest'
 * dist-tag and the stable tag set. A future same-core PREVIEW must not raise this
 * base — v2.43.0-preview.1 existing means 2.43.0 is being worked toward, not
 * consumed.
 *
 * REFUSES kind="patch" when a preview tag exists for a core above the base: per
 * §4.0 the result would rank below the highest tag and could never be released.
 * previewTags is an input ONLY for that refusal check; it never raises the base.
 */
export function nextStableRelease(input: {
  kind: "patch" | "minor" | "major";
  stableTip: string | null;      // npm 'latest'
  stableTags: string[];          // tags with no prerelease component
  previewTags: string[];         // refusal check only
}): string;

/**
 * The next PREVIEW release: a core outranking the newest stable, then a prerelease
 * outranking every existing preview on that core.
 *
 * Two-step by necessity. A preview is BELOW its own stable core, so it can never be
 * derived by bumping a global floor — the result would either collide with a
 * published preview or rank behind the stable it precedes.
 *
 * kind selects the CORE, exactly as for a stable release; the prerelease suffix is
 * then attached to it. Without kind, patch/minor/major would all resolve
 * identically and the flag would be silently ignored.
 *
 * Both tips AND both tag sets are required. npm metadata and the tag set can
 * disagree — the live repository is in exactly that state (npm preview
 * 2.40.0-preview.20260902 vs origin/preview 2.43.0-preview.20260904, with no
 * matching tag) — and a resolver seeing only one source cannot advance past a
 * partial publication.
 */
export function nextPreviewRelease(input: {
  kind: "patch" | "minor" | "major";
  stableTip: string | null;      // npm 'latest'
  stableTags: string[];          // the core floor
  previewTip: string | null;     // npm 'preview'
  previewTags: string[];
  stamp: string;                 // YYYYMMDD, supplied by the caller
}): string;
```

### 4.3 How `nextPreviewRelease` resolves

1. **Core.** `base = max(stableTip, newest stable tag)`, then apply `kind`:
   `minor` -> `X.(Y+1).0`, `major` -> `(X+1).0.0`, `patch` -> `X.Y.(Z+1)`.
   For `minor` this equals `nextDevelopmentVersion(base)`; the other kinds are
   precisely why `kind` must be an input.
2. **The incumbent.** Compute
   `incumbent = max(previewTip, ...previewTags)` **restricted to the resolved core**,
   using the strict comparator. Both sources feed one maximum: that is what makes an
   npm/tag disagreement safe, and neither source alone is sufficient (§6 rows 7-8).
   When no preview exists on that core, the candidate is `<core>-preview.<stamp>` and
   the remaining steps do not apply.
3. **Succession from the incumbent, not from the stamp.** Compare the supplied
   `stamp` against the incumbent's stamp:

   | supplied stamp vs incumbent's | candidate |
   |---|---|
   | strictly newer | `<core>-preview.<stamp>` (bare) |
   | equal | `<core>-preview.<stamp>.<n+1>`, where `n` is the incumbent's ordinal (absent = 1) |
   | older | **throw** a clock-regression error naming both stamps |

   Deriving the ordinal from the **incumbent's** ordinal is what makes `.3` -> `.4`
   work; a hard-coded `.2` would collide as soon as a third same-day cut happened.
   The ordinal ordering is SemVer's: numeric identifiers compare numerically, and a
   longer identifier set outranks a shorter one when all preceding identifiers are
   equal — the comparator at `scripts/release.ts:323-335` already implements it.

   The **older** row is a real state, not a hypothetical: a runner with a skewed
   clock, or a maintainer passing an explicit stamp, can produce it. Silently
   emitting a behind candidate would leave the global assertion (§4.4) to catch it
   with a message that names versions rather than the actual cause, so it fails here
   with the diagnosis instead.

A `patch` preview inherits the §4.0 refusal for the same reason a stable patch
does: if a higher core is already previewed, a lower-core prerelease cannot outrank
it.

**Post-condition, asserted in code:** the returned candidate strictly outranks the
incumbent. With step 3 this holds by construction; asserting it turns a future
algorithm edit into a test failure rather than a bad publish.

### 4.4 Validation, not bumping

The candidate is checked against the **global** floor before being returned:

```ts
// Must outrank everything published by any route. An ASSERTION, not an input to the
// computation — mixing channels at computation time is what produces §4.1's
// failures.
if (compareVersions(candidate, globalFloor) <= 0) throw new Error(...);
```

Because §4.0 refuses the cases that would fail it, this should never fire in normal
use. It is a backstop: if it fires, the resolver and the invariant disagree, and the
release must stop rather than proceed on a version the repository will reject two
steps later.

## 5. What survives untouched

`assertUnusedReleaseVersion` (`:372-391`) and `assertChannelVersionMovesForward`
(`:342-370`) both take the version as an argument and never read `package.json`.
Both survive unchanged and run against the resolved `X`. The branch gate
(`:494-511`) and the bump/commit/push block (`:559-591`) are untouched.

## 6. Resolver cases — `tests/version-line.test.ts`

Each case discriminates a specific wrong implementation.

| Case | Fixture | Expected | Kills |
|---|---|---|---|
| future preview does not raise a stable bump | `latest=2.42.0`, preview tag `v2.43.0-preview.1`, `minor` | `2.43.0` | §4.1 failure 1 |
| **patch refused above an open preview** | `latest=2.42.0`, preview tag `v2.43.0-preview.1`, `patch` | **throws**, message names the preview | §4.0; an implementation returning `2.42.1` |
| patch allowed with no higher preview | `latest=2.42.0`, no preview tags above `2.42.0`, `patch` | `2.42.1` | over-broad refusal |
| preview after a stable | `latest=2.42.0`, no preview tags on 2.43.0, `minor` | `2.43.0-preview.<stamp>` | §4.1 failure 2 |
| same-core preview ordinal | as above, tag `v2.43.0-preview.20260904`, same stamp | `2.43.0-preview.20260904.2` | the fixed point |
| **preview kind is honoured** | `latest=2.42.0`, `major` | `3.0.0-preview.<stamp>` | dropping `kind` — every kind returning 2.43.0 |
| **ordinal continues from the incumbent** | tag `v2.43.0-preview.20260904.3` exists, same stamp | `2.43.0-preview.20260904.4` | a hard-coded `.2` |
| **preview tip ahead, stamp EQUAL to it** | `previewTip=2.43.0-preview.20260910` (no matching tag), no preview tags on the core, `stamp=20260910` | `2.43.0-preview.20260910.2` | reading tags only — a tags-only build sees no incumbent and returns the bare stamp |
| **preview tags ahead, stamp EQUAL to them** | `previewTip=2.40.0-preview.20260902`, tag `v2.43.0-preview.20260910` on the core, `stamp=20260910` | `2.43.0-preview.20260910.2` | reading the npm tip only — a tip-only build sees no same-core incumbent and returns the bare stamp |
| **clock regression is refused** | incumbent stamp `20260910`, supplied `stamp=20260904` | **throws**, message names both stamps | silently returning a behind candidate |
| stable floor from tags, not the preview channel | `previewTip=2.40.0-preview.20260902`, stable tags to `v2.42.0` | core is `2.43.0`, never `2.41.*` | channel-only base |
| preview-to-stable promotion | `latest=2.42.0`, tag `v2.43.0-preview.20260904`, stable `minor` | `2.43.0` | treating the preview as consumed |
| monotonicity post-condition | any preview input with an incumbent | `compareVersions(result, incumbent) > 0` | silent no-op successors |

**Rows 8 and 9 are the pair that force both sources to be read, and their stamps are
pinned deliberately.** An earlier version of these rows left the stamp unspecified,
so a tags-only implementation could pass the "tip ahead" row purely because the test
stamp happened to be newer than the tip — the assertion would hold for the wrong
reason. Fixing the supplied stamp **equal** to the incumbent's removes that escape:
the expected value (`...2`) is reachable only by an implementation that actually
found the incumbent in that row's source. An older stamp would work equally well;
equal is used because it also exercises the ordinal path.

Row 11 is today's live state (`000_research.md` §11.3).

## 7. CLI cases — `tests/release-helper.test.ts`

1. `--bump minor` with `npmLatest: "9.9.9"` runs `npm version 9.10.0
   --no-git-tag-version` and dispatches `version=9.10.0`.
2. `--bump` plus an explicit version is rejected before any command runs.
3. An invalid `--bump` kind is rejected before any command runs.
4. **The tag set is consulted, not only the channel:** `npmLatest: "9.9.0"` with a
   `v9.9.5` tag, **`--bump patch`** must yield `9.9.6`.

   `patch` is deliberate. With `minor` both bases yield `9.10.0`, so the assertion
   would pass against an implementation that never read the tags. `patch`
   discriminates: channel-only gives `9.9.1`, tag-aware gives `9.9.6`.
5. `--bump` on `preview` produces a string matching
   `^\d+\.\d+\.\d+-preview\.\d{8}(\.\d+)?$`.
6. **The §4.0 refusal reaches the operator:** `--bump patch` with a higher-core
   preview tag exits non-zero, prints the explanatory message, and logs no
   `npm version` or `git commit` call.

The fixture already shims `git` (`tests/release-helper.test.ts:100-120`); cases 4,
5 and 6 need a `tag --list` response added to it — a fixture extension, not a new
harness.

## 8. IN / OUT

IN: argument parsing in `scripts/release.ts`, the two resolvers in
`scripts/version-line.ts`, their tests, the contributing docs (including the §4.0
consequence, which is operator-visible policy).

OUT: every workflow file; the bump/commit/push block; the dispatch shape; anything
in `030`; any change to `tests/release-version-line.test.ts`.

## 9. Accept criteria

1. `bun test tests/version-line.test.ts` green, with all eleven §6 rows.
2. `bun test tests/release-helper.test.ts` green, with the six §7 cases.
3. `bun run typecheck`.
4. `bun run privacy:scan` — this phase edits the file holding the SSH-target
   assembly (`scripts/release.ts:154-219`), whose comments record that a literal
   remote reads as an email address to the scanner.
5. Manual: `bun scripts/release.ts --bump minor` on a non-release branch aborts at
   the branch gate (`:511`) before any network call. Not automated; no existing test
   covers "aborts before a network call on a wrong branch".

All five commands exist and read the changed files directly. Verified to exist and
be correctly targeted, not verified to pass — no code exists yet.

## 10. Activation grounding

| Path | Trigger | Observable |
|---|---|---|
| stable resolver | §7 case 1 | `npm version 9.10.0`, `version=9.10.0` dispatched |
| tag floor consulted | §7 case 4 | `9.9.6`, not `9.9.1` |
| §4.0 patch refusal | §6 row 2, §7 case 6 | throw/exit naming the blocking preview tag |
| patch still allowed otherwise | §6 row 3 | `2.42.1` |
| preview kind honoured | §6 row 6 | `3.0.0-preview.*` for `major` |
| npm tip vs tags | §6 rows 7-8 | candidate outranks whichever source is ahead |
| ordinal disambiguation | §6 row 5 | `...20260904.2` |
| both-forms rejection | §7 case 2 | non-zero exit, empty call log |
| invalid kind rejection | §7 case 3 | non-zero exit, empty call log |
| global-floor backstop | candidate below floor | throw naming both versions |
