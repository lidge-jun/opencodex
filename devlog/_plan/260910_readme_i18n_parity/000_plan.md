# README i18n parity — plan

## Objective

Resync the seven non-English READMEs under `readme/` to the current `README.md`, and add a
mechanical guard so the same drift cannot accumulate silently again.

## Current state (evidence)

`README.md` last moved at `2f3f82680`. Every `readme/README.*.md` last moved at `8bc9e4ee2`,
seven README-touching commits earlier:

```text
2f3f82680 feat(sponsors): PackyCode Standard sponsor preset, README row and docs (#3915)
037137a50 fix(readme): show the OrcaRouter sponsor logo on every branch (#4097)
4b379b9ec feat(sponsors): OrcaRouter placement, overview introduction and links (#3914)
615c5c62c feat(provider): add Qoder CN PAT provider
124c57b1f feat(provider): add Qoder Global PAT provider
17d2a1715 docs(readme): one sponsor line pointing at SPONSORS.md (#3923)
aeefb3ab5 docs(readme): one-line Sponsors slot, sponsorship summary and contact (#3918)
  ^ last shared ancestor: 8bc9e4ee2 docs: publish the sponsorship rule set (#3910)
```

The divergence is structural, not cosmetic. The English README was reorganized into a
four-product hero table, a `## Quick start` section holding `### Personal install`,
`### Sponsors` and three `<details>` blocks (Docker Compose, install from source, for agents),
a `### Health and readiness` subsection, and a memory-ownership `<details>` block. Five of the
seven locales — ko, ja, ru, zh-CN, zh-TW — still carry the pre-reorganization outline with
sections the English file no longer has (`## Adding a provider`,
`## OpenAI provider account modes`, `## Configuration`), and none of the seven carries the
sponsor table, the Docker Compose block or the memory-ownership block. `README.fr.md` is the
closest: it has the four-product hero and the readiness section but predates the sponsor and
Docker work. `README.tr.md` is the shortest at 172 lines against 399 English.

## Constraints

- `README.md` is the source of truth and must not change in this unit.
- Write scope: `readme/*.md`, `readme/i18n-manifest.json`,
  `tests/ci-workflows/docs-readme-translation-parity.test.ts`,
  `scripts/test-layout/layout.json`, `tests/fixtures/test-layout-expected.json`,
  and this unit directory.
- Out of scope: `docs-site/` translations, GUI i18n, runtime source, release, merge, deploy.
- The user forbade the local product suite, typecheck and build for this task. The only local
  execution is the new guard test file; remote CI on the pushed head is the authoritative
  evidence, and the push uses `--no-verify`.
- Translation drafting is delegated to parallel `xai/grok-4.6` subagents, one locale per agent,
  disjoint write sets. Korean additionally passes the `cxc-kwrite` four-pass revision.

## Work-phase map

| Phase | Doc | Outcome | Depends on |
|---|---|---|---|
| wp1 | this unit | roadmap locked | — |
| wp2 | `010_phase1_parity_guard.md` | manifest + guard test + layout registration | wp1 |
| wp3 | `020_phase2_locale_resync.md` | seven locales resynced, guard green | wp2 |
| wp4 | `030_phase3_delivery.md` | branch pushed, PR open against `dev` | wp3 |

The guard lands before the translations on purpose: it is the executable specification the
seven drafts are integrated against, so an incomplete draft fails a check instead of a review.

## Why a manifest and not only a structural diff

A structural comparison catches a missing section. It cannot catch a paragraph rewritten in
English inside a section every locale still has — which is most of what accumulated here. A
recorded per-locale `sourceSha256` of the English file catches exactly that case, and names
which locales are stale rather than failing as one opaque check. The structural checks stay
because the hash alone can be satisfied by editing one JSON field.
