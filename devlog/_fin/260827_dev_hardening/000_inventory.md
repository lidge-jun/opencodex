# 260827 dev hardening — inventory

Head: `dev` @ `7547c8937`. Baseline: `origin/main` @ `ec51e42d7` (`v2.33.0`).
Delta: 254 commits, 551 files, +44296/-1917. Goal: make this head promotable.

## Baseline that already holds

| gate | result |
|---|---|
| full suite on `ssh lidge` at `7547c8937` | `hardsuite: OK rc=0` |
| dev CI on `7547c8937` | `completed success` |
| `bun x tsc --noEmit` | clean |
| `bun run privacy:scan` | passed |
| `bun run lint:gui` | exit 0 (1 warning) |
| `docs-site` build | 401 pages, success |

Earlier dev runs show `cancelled` for `70159d9e7` and `77e037077`. That is
`concurrency: cancel-in-progress: true` (`.github/workflows/ci.yml:52-54`) superseding
in-flight runs as merges landed back to back — not failures. The head run is green.

## Blocker 1 — promoting this head produces an unpublishable version

`dev` has not touched `package.json` since the merge base, so the merge RESULT carries
the already-consumed release string:

```
$ git merge-tree --write-tree origin/main origin/dev -> tree 6c33df7a8
$ git cat-file -p 6c33df7a8:package.json | jq -r .version
2.33.0

$ npm view @bitkyc08/opencodex dist-tags
{ "latest": "2.33.0", "preview": "2.33.0-preview.20260825" }
```

So a `dev` -> `main` promotion succeeds in git and then fails at publish:
`assertUnusedReleaseVersion` (`scripts/release.ts`) refuses a consumed version, and
`release.yml` refuses an existing npm version / git tag / GitHub Release. The trap is
that `release.yml`'s documented "bump package.json before dispatching" path leaves
`2.33.0` already matching, so the version check PASSES and the failure only surfaces at
`npm publish`.

`dev`'s own string is worse: `2.32.1-preview.20260825` is BEHIND `latest`, so
`assertChannelVersionMovesForward` rejects it as a channel regression. It is also the
runtime identity — `src/cli/help.ts`, `src/server/management-api.ts`,
`src/update/index.ts`, `bin/ocx.mjs` all read it — so `ocx --version` on a source
install prints a preview npm superseded twice, and `defaultUpdateTag()` reads the
`-preview.` suffix and points `ocx update` at the preview channel.

`2.34.0` is free (`npm view ... E404`, no `v2.34.0` tag). This exact class was already
fixed once in `32529c2b2` / PR #2136.

## Blocker 2 — credential identity is not fully rebound after 429 rotation

`applyFailoverSnapshot` (`src/server/responses/core.ts:2830-2845`) swaps `apiKey`,
Copilot transport, Antigravity `project` and Kiro context — but does NOT update
`sentOAuthSnapshot`, which is assigned once at line 2883.

A later pre-stream 401 (lines 3516-3529, 5043-5055) refreshes
`forceRefreshOAuthAccessSnapshot(sentOAuthSnapshot)` — still account A — after HTTP 429
already rotated to account B at line 5219. The Copilot transport is then resolved from
the ACTIVE credential rather than the refreshed snapshot, so A's bearer can be paired
with B's allowlisted `*.githubcopilot.com` origin. Preventing exactly that mix is why
the failover snapshot exists.

Related, same root cause: the runTurn 429 path (line 4632) clears Cursor conversation
state and rebinds replay identity, but the HTTP 429 path (5219) and the sidecar 429
path (4330) do not. Continuation/thought-signature state minted under A can be replayed
under B.

## Not a defect — presence-driven failover default

Rotation defaults on when 2+ eligible accounts exist
(`src/oauth/generic-account-failover.ts:104-128`, "Presence IS consent", #2568d).
A reviewer flagged this as a release risk. It is a recorded owner decision with explicit
precedence (per-provider boolean > global boolean > presence), and `hasKeyPoolFailover`
already reads a 2+ key pool the same way. Left as-is; the stale comment at
`core.ts:5194` calling it "opt-in and a strict no-op otherwise" is wrong and should be
corrected.

## Docs contradict the code in shipped locales

```
$ for k in defaultModelAliases promptCacheKey oauthAccountFailover auto_review_model noProxy; do ...
defaultModelAliases: en=1 locales=0
promptCacheKey:      en=1 locales=0
oauthAccountFailover:en=1 locales=0
auto_review_model:   en=1 locales=0
noProxy:             en=1 locales=0
```

Seven locales (fr/ja/ko/ru/tr/zh-cn/zh-tw) document none of the five new config
surfaces. Worse, two locales state the OPPOSITE of the code: FR
`fr/reference/adapters.md:33` and TR `tr/reference/adapters.md:52` say ClinePass clamps
every requested tier to `low`, while `src/providers/registry.ts:1604` seeds
`["low","medium","high","xhigh","max"]` and the English page says the tier is preserved.

## Local gate that fails while CI passes

`bun run doctor:gui` exits 1 on 2 warnings, both the same
`gui/src/pages/Models.tsx:498` missing-dependency finding. The omission is deliberate
and documented in-file, but the suppression comment names `react/react-compiler` and
`eslint react-hooks/exhaustive-deps` — neither silences oxlint's own
`react-hooks(exhaustive-deps)` nor react-doctor's `react-doctor/exhaustive-deps`.

`doctor:gui` is part of `prepush`, so every gui-touching push needs `--no-verify`.

## Deferred from the bug-PR merge round

1. `parsedProfileEfforts` cannot read commandcode.ai profiles (dead for every row).
2. Field backfill mutates verbatim passthrough bodies (`status` and `created_at`).
3. #2671's "probed 2026-08-26" provenance is unverified on a merged change.
