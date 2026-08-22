# 150 — Phase 16: test-home isolation + Desktop allowlist docs (PRs #997, #999)

Credit: **Yuxin Qiao**
(`Yuxin Qiao <email from PR head>`), PRs #997 and
#999. Adoption: near-verbatim cherry-pick of both.

Two small, independent, merge-clean contributions from the same author, landed
together as the stack's last content phase.

## Slice A — usage-log fixture isolation (#997)

`tests/management-api-logs-metrics.test.ts` wrote fixtures into the real
OpenCodex home, so running the suite could touch a developer's actual usage log.

Source commits `3304d5c83`, `cdebe0e13`:

| Path | Op | Content |
|------|----|---------|
| `tests/management-api-logs-metrics.test.ts` | MODIFY | +51/−2: pin fixture writes to the scratch home and assert the target path and content explicitly, so the isolation is proven rather than assumed |

The explicit target assertion is what makes this non-vacuous — a test that
merely stopped writing would pass silently even if isolation broke again.

## Slice B — Desktop remote allowlist documentation (#999, issue #241)

Routed rows are emitted with `visibility = "list"`
(`src/codex/catalog/sync.ts:240`), but Codex Desktop applies its own allowlist
downstream — outside this repository (upstream openai/codex#19694). The
limitation and its workaround were undocumented.

Source commit `d849dc631`:

| Path | Op | Content |
|------|----|---------|
| `docs-site/src/content/docs/guides/codex-app-models.md` | MODIFY | +17: the limitation and the workaround |
| `docs-site/.../{ja,ko,ru,zh-cn}/guides/codex-app-models.md` | MODIFY | +52 total: matching localized notes |

Docs-only; #241 stays **open** as an upstream tracker — documenting a
limitation is not fixing it.

## Execution

```
git cherry-pick 3304d5c83 cdebe0e13 d849dc631
```

## Verification

- `bun test tests/management-api-logs-metrics.test.ts`
- `bun run typecheck`
- `bun run privacy:scan`

## PR

Stack 15, base = stack 14 head. Credits Yuxin Qiao for both slices. References
#241 without closing it.
