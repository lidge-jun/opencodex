# 010 — move dev off the consumed 2.36.0 (wp2)

One line. `package.json` `version`: `2.36.0` -> `2.37.0`.

## Why 2.37.0

Verified against the real state, not read off a pattern:

| candidate | verdict |
|---|---|
| `2.36.0` (current) | tag `v2.36.0` names `c7d8407d2`, not dev's head; npm `latest` = 2.36.0. Consumed. |
| `2.36.1` | mechanically legal but labels the range a patch, against the `befcac3e1` precedent |
| `2.36.1-preview.*` | contradicts "dev carries the next STABLE version" |
| `2.37.0` | `npm view @bitkyc08/opencodex@2.37.0` -> E404; no `v2.37.0` in the tag set; forward of every tag |

Highest existing tag by the repository's own ordering is `v2.36.0` — NOT the
later-dated `v2.36.0-preview.20260830`. Sorting all 218 `v*` tags with
`compareReleaseTags` puts the stable release above its own prerelease, which is
correct SemVer precedence and the reason the failing message names `v2.36.0`:

```
top 5: v2.34.0  v2.35.0  v2.36.0-preview.20260829  v2.36.0-preview.20260830  v2.36.0
HIGHEST = v2.36.0
compareReleaseTags("v2.37.0", "v2.36.0") -> 1
```

The first draft of this doc asserted the preview was highest while claiming to have
run the comparator. It had not. Run it.

npm dist-tags at the time of writing: `latest` = 2.36.0, `preview` =
2.36.0-preview.20260830.

## The diff

```json
-  "version": "2.36.0",
+  "version": "2.37.0",
```

No other file carries the product version. `gui/package.json` is `0.0.0`,
`docs-site/package.json` is `0.0.1`, and `src/generated/*` hold catalog hashes.
Re-verify with a repo-wide search excluding `node_modules`, `.tmp`, `devlog`,
`gui/dist` before claiming the line is unique.

## Verification

- `bun test tests/release-version-line.test.ts` — all three tests pass, including
  "the in-tree version is never behind a released one" which currently fails.
- Re-run the freeness checks (`npm view`, `git tag --list`) immediately before
  committing: another release landing mid-cycle would consume the candidate.

## What this does not do

It does not publish, tag, or promote, and it does not stop the next release from
stranding dev again. That is `020`.
