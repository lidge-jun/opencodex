# 010 — Phase 1: one version algebra, in a testable module

Foundation. No behaviour change; this phase gives phases 2-4 a single, importable
definition of ordering and succession.

Depends on: nothing. Everything else depends on this.

## 1. The defect this closes

The repository orders releases in two places:

- `compareReleaseVersions` — `scripts/release.ts:303-337` (throws on bad input)
- `compareReleaseTags` — `scripts/release-notes.ts:66-79` (falls back on bad input)

Tests can only reach the second. `tests/release-version-line.test.ts:27-29` records
why: `scripts/release.ts` parses `process.argv` and calls `process.exit` at module
scope (`:482-491`), so importing it from a test kills the runner.
`compareReleaseVersions` is therefore exercised only through a subprocess fixture
(`tests/release-helper.test.ts:708-723`, three cases).

## 2. Two comparators, deliberately

The two behaviours are **not** an accident to be unified. They serve different
callers and both are correct:

```ts
/**
 * Strict ordering for release DECISIONS. Throws on unparseable input, because a
 * decision must fail closed: scripts/release.ts:305-307 records that Number() on a
 * garbage core yielded NaN and made the forward guard pass any candidate.
 */
export function compareVersions(left: string, right: string): number;

/**
 * Lenient ordering for TAG SETS, which contain whatever history contains. Falls back
 * to numeric-aware locale compare exactly as release-notes.ts:66-70 does today.
 */
export function compareTagsLenient(left: string, right: string): number;
```

Collapsing them onto one throwing function would be a live regression:
`scripts/build-release-changelog.ts:137` admits any `/^v\d/` tag into its candidate
set, so a single malformed historical tag — harmless today — would newly **abort
release-note generation**.

## 3. File change map

| Path | Action |
|---|---|
| `scripts/version-line.ts` | **NEW** — the algebra |
| `scripts/release-notes.ts` | MODIFY — `compareReleaseTags` delegates to `compareTagsLenient` |
| `scripts/release.ts` | MODIFY — delete the duplicate, re-export `compareVersions` |
| `scripts/bump-dev-version.ts` | MODIFY — use the shared `nextDevelopmentVersion` |
| `tests/version-line.test.ts` | **NEW** |
| `tests/bump-dev-version.test.ts` | unchanged — see §7 |

## 4. `scripts/version-line.ts`

Pure at the module level: no I/O, and nothing that runs on import. That is what makes
it importable from a test, which is the whole reason it exists —
`scripts/release.ts` is unimportable precisely because it parses `process.argv` and
exits at module scope (`tests/release-version-line.test.ts:27-29`).

`030` later adds a small CLI to this file behind an `import.meta.main` guard, the
same pattern `scripts/release-notes.ts` uses. That guard is what keeps the module
importable, so it does not weaken this property — but every exported function must
stay free of `process.exit` so a caller decides what a failure means.

```ts
export interface ParsedVersion {
  major: number; minor: number; patch: number;
  prerelease: readonly string[] | null;
}

/** Optional leading v, optional prerelease, optional (ignored) build metadata. */
export function parseVersion(raw: string): ParsedVersion | null;

export function compareVersions(left: string, right: string): number;
export function compareTagsLenient(left: string, right: string): number;

/**
 * The version a development line carries once \`released\` exists.
 *
 *   X.Y.Z-preview.*  ->  X.Y.Z         (befcac3e1)
 *   X.Y.Z (stable)   ->  X.(Y+1).0     (e4a85d134, 076ad3036, 32529c2b2)
 *
 * Lifted from scripts/bump-dev-version.ts:106-108. The rule was got wrong once in
 * design — "increment the released minor" — and befcac3e1 disproves it, so the
 * prerelease row is load-bearing rather than an edge case.
 */
export function nextDevelopmentVersion(released: string): string;
```

`nextDevelopmentVersion` takes one argument. `decideDevVersion`'s second parameter
answers "is dev already ahead?" (`scripts/bump-dev-version.ts:120-126`), which stays
in that script because `030` still needs it.

`020` extends this module with `nextStableRelease` and `nextPreviewRelease`. They are
not part of this phase.

## 5. `scripts/release-notes.ts`

`compareReleaseTags` keeps its name, signature and **exact current behaviour** —
`tests/release-version-line.test.ts:4` and `scripts/bump-dev-version.ts:57` import it:

```diff
+import { compareTagsLenient } from "./version-line";
+
 export function compareReleaseTags(a: string, b: string): number {
-  const pa = parseReleaseTag(a);
-  const pb = parseReleaseTag(b);
-  if (!pa || !pb) return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
-  /* ... core/prerelease comparison ... */
+  return compareTagsLenient(a, b);
 }
```

`compareTagsLenient` accepts an optional `v` prefix, which is what
`scripts/bump-dev-version.ts:68-70` (`asTag`) works around today; that helper's own
comment (lines 61-67) records the `vv2.36.0` double-prefix bug the workaround caused.
Accepting both forms in the parser removes the class.

## 6. `scripts/release.ts`

```diff
-export function compareReleaseVersions(left: string, right: string): number {
-  /* lines 303-337 */
-}
+export { compareVersions as compareReleaseVersions } from "./version-line";
```

The alias keeps `assertChannelVersionMovesForward` (`:360`) and the three
`tests/release-helper.test.ts` cases (`708-723`) untouched.

## 7. `scripts/bump-dev-version.ts`

Retained — `030` retargets it. Here it only stops owning the rule:

```diff
+import { nextDevelopmentVersion } from "./version-line";
+
 export function decideDevVersion(released: string, current: string): BumpDecision {
-  const candidate = rel.prerelease === null
-    ? \`\${rel.major}.\${rel.minor + 1}.0\`
-    : \`\${rel.major}.\${rel.minor}.\${rel.patch}\`;
+  const candidate = nextDevelopmentVersion(released);
```

The ahead-check, the atomic rewrite and the CLI are unchanged, so
`tests/bump-dev-version.test.ts` stays green **without edits**. That is the proof the
extraction was faithful, and it is this phase's primary gate.

## 8. IN / OUT

IN: creating `scripts/version-line.ts`; redirecting the three callers; adding
`tests/version-line.test.ts`.

OUT: release behaviour, workflow YAML, the invariant test's logic, `--bump`, the
`020` resolvers. A workflow file in this phase's diff should be rejected.

## 9. Accept criteria

1. `bun test tests/version-line.test.ts` — new. Covers the `decideDevVersion` rows
   from `tests/bump-dev-version.test.ts:44-96` re-expressed against
   `nextDevelopmentVersion`, the build-metadata and unparseable cases from
   `tests/release-helper.test.ts:708-723`, and the lenient/strict distinction:
   `compareTagsLenient("vNOTAVERSION", "v2.42.0")` returns a number,
   `compareVersions` on the same input throws. Both in one test so the distinction
   cannot be optimised away later.
2. `bun test tests/bump-dev-version.test.ts` — **unchanged file, still green.**
3. `bun test tests/release-notes.test.ts` — green; the file that would catch a
   fallback regression (948 lines).
4. `bun test tests/release-version-line.test.ts` — green.
5. `bun test tests/release-helper.test.ts` — green.
6. `bun run typecheck`.

All six exist and read the changed files directly: `bun run typecheck` is
`bun x tsc --noEmit`, which covers `scripts/` under the root tsconfig, and each
`bun test` names its file as a direct argument. Verified to exist and be correctly
targeted, not verified to pass — no code exists yet.

## 10. Activation grounding

| Path | Trigger | Observable |
|---|---|---|
| `parseVersion` returns null | `"not-a-version"`, `"2.36"`, `"garbage"` (the strings at `tests/bump-dev-version.test.ts:92-96`) | `compareVersions` throws `not parseable` |
| lenient fallback | `compareTagsLenient("vNOTAVERSION", "v2.42.0")` | returns a number, no throw |
| prerelease succession | `nextDevelopmentVersion("2.36.0-preview.20260829")` | `"2.36.0"`, not `"2.37.0"` |

Row 1 matters specifically because `scripts/release.ts:305-307` documents that the
NaN path once made the forward guard accept anything.
