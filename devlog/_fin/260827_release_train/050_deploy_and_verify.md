# 050 — docs deploy and installed-runtime proof

## Docs deploy

`deploy-docs.yml` triggers on push to `main` under `docs-site/**`. The `030` promotion
carries 293 commits of `docs-site` changes, so the deploy should fire on that merge without
a manual dispatch. Confirm rather than assume: if the path filter did not match, dispatch it.

## Installed-runtime proof

Registry metadata is not the same claim as a working install. Install the published
version into a scratch prefix and run it:

```
cd "$(mktemp -d)" && npm i @bitkyc08/opencodex@2.34.0 && npx ocx --version
```

The version the runtime reports is the evidence, not what the registry says it stored.

## Release record

Write the outcome to this unit: both channel versions, both release commits, both workflow
run ids, the docs deploy run id, and what was deliberately NOT included (#2745). Then the
unit is closable to `_fin`.

## Acceptance

- the docs deploy run for the `main` release concluded `success`
- a real install of `2.34.0` reports `2.34.0` from its own runtime
- the record names every sha and run id rather than describing them

## Outcome — the release record

### Both channels, both commits

| Channel | Version | Release commit | Branch head |
| --- | --- | --- | --- |
| `preview` | `2.34.0-preview.20260827` | `809a06ba00340c905dfac4ab588616e638c2fbfd` | `origin/preview` |
| `latest` | `2.34.0` | `80fff9a7f47332a4445df2b26ea175053fa55b0b` | `origin/main` |

`dev` stayed at `7ca954ffd997197d1cff6fc6d69842be51177a8f` throughout; both release trees are
byte-identical to it apart from the preview's version string. `main` needed no separate
release commit — the promotion merge is the release commit, for the reason in `030`.

### Run ids

| What | Run |
| --- | --- |
| preview push CI | `33072435012` |
| preview service lifecycle | `33072435013` |
| preview release dry run | `33073378226` |
| preview release publish | `33073503058` |
| promotion branch CI (the one that caught the version-line regression) | `33074009466` |
| promotion branch hygiene (after relabel) | `33074473195` |
| main push CI | `33075147758` |
| main service lifecycle | `33075147219` |
| main release dry run | `33076185925` |
| main release publish | `33076348477` |
| docs deploy | `33075147234` |

Remote full suite: `pvsuite` on `ssh lidge` at `62dfc6c54` (the tree both releases ship),
15334 pass / 0 fail, rc=0.

### Docs deploy

`deploy-docs.yml` fired on the promotion push without a manual dispatch, as expected from
the `docs-site/**` path filter. Run `33075147234` at `80fff9a7f`, both `build` and `deploy`
jobs success, and the `github-pages` deployment `6123269073` is bound to that same sha.
`https://opencodex.me/` answers `200` and serves the expected title. The legacy
`/pages/builds/latest` API returns 404 here because Pages is workflow-built, not
legacy-built — that is not a failure signal.

### Installed-runtime proof

In a `mktemp -d`: `npm pack @bitkyc08/opencodex@2.34.0` then unpacked gives
`package/package.json` at `2.34.0` with `package/gui/dist/index.html` present and both
`bin` entries intact; installing it and running the installed binary prints
`opencodex 2.34.0`. Packed size matched the preview exactly — 838 files, 9.3 MB packed,
19.9 MB unpacked — which is what publishing identical trees to two channels should look
like.

### What is deliberately NOT in this release

PR #2745 (OAuth 429 credential-identity rebind) is unmerged, awaiting the security review
`MAINTAINERS.md` requires for credential-handling changes. The drift it fixes ships to both
channels unfixed. This was disclosed in the readiness statement before the train started and
is not a decision made here.

Separately, and worth stating plainly rather than burying: `dev` carries 84 open CodeQL
alerts (78 high) against `main`'s previous 73, so this train raises the open-alert count by
11. None were introduced by the promotion itself — the branch diff against `dev` was empty —
but they now ship on `latest`. Triaging them is separate work against `dev`.
