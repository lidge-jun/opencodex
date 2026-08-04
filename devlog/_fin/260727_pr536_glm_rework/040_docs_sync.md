# 040 — Provider documentation sync

Work phase: `wp5-docs` · Criterion: `c6-docs`

## Files and exact anchors

Every locale carries the same endpoint table with a `Z.AI (GLM Coding)` row. The
new row goes directly beneath it in each file:

| File | Line of the `Z.AI` row |
|------|------------------------|
| `docs-site/src/content/docs/guides/providers.md` | 184 |
| `docs-site/src/content/docs/ko/guides/providers.md` | 121 |
| `docs-site/src/content/docs/ja/guides/providers.md` | 121 |
| `docs-site/src/content/docs/ru/guides/providers.md` | 131 |
| `docs-site/src/content/docs/zh-cn/guides/providers.md` | 114 |

## English source

```diff
 | Z.AI (GLM Coding) | `https://api.z.ai/api/coding/paas/v4` |
+| Zhipu AI (BigModel) | `https://open.bigmodel.cn/api/paas/v4` |
```

The table alone does not say why there are two GLM rows, so the English guide
also gets one clarifying sentence after the table, near the existing adapter
note:

> **Two GLM routes:** `zai` is the Z.AI international coding-plan subscription;
> `zhipu-bigmodel` is Zhipu's domestic BigModel pay-as-you-go endpoint. They use
> different hosts, different keys, and different billing — a key issued for one
> will not authenticate against the other.

## Locales

The table row is added in all four. The clarifying sentence is translated for
each locale rather than left in English, since the surrounding prose is
translated; the constraint from AGENTS.md is that no locale contradicts the
English source, and a silently English paragraph in a Korean guide is a
different defect than a contradiction but still a regression in the page.

Row labels stay in the locale's existing convention: `zh-cn` uses Chinese vendor
names where the surrounding rows do, `ko`/`ja`/`ru` keep the Latin product name
as those tables already do for `Z.AI`.

## Verification

```bash
rg -n 'open.bigmodel.cn/api/paas/v4' docs-site/src/content/docs
```

Expect five hits, one per locale. No docs build is run here — this is a table row
and a paragraph in existing Markdown, and the site build is CI's job.
