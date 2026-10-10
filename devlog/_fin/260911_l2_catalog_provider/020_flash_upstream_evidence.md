# 020 — what upstream actually publishes about Flash on the Responses endpoint

`010` records the decision to leave `glm-5.3-flash` out of the Responses roster. This is the
evidence behind it, gathered from BigModel's own documentation on 2026-09-11, so the next unit does
not have to rediscover it. It changes nothing in the product.

## The bar

The issue makes Flash conditional on the domestic Responses endpoint supporting it, with verified
context, modalities and reasoning metadata, and asks for the upstream restriction to be documented
otherwise. The maintainer review says the same thing in the other direction: seed Flash only after
proof it works on that endpoint, and update the roster oracle in the same change.

## What the vendor publishes

| Page | What it says |
|---|---|
| `coding-plan/tool/codex.md` | Codex integrates at `https://open.bigmodel.cn/api/v1` with `wire_api = "responses"`. Its `models.json` example declares `glm-5.3` and `glm-5-turbo`. Flash appears nowhere on the page. Unchanged since it was checked on 2026-09-07. |
| `coding-plan/overview.md` | "所有套餐均支持 GLM-5.3、GLM-5.3-Flash." And: a call to `GLM-5-Turbo` or `GLM-4.7` is auto-switched to `GLM-5.3-Flash`. |
| `coding-plan/latest-model.md` | The plan supports GLM-5.3 and GLM-5.3-Flash for every tier, and lists the three protocol endpoints with Codex on `/api/v1`. The switching procedures it gives are for Claude Code (Anthropic wire) and Cline (Chat wire). There is no Codex procedure. |
| `coding-plan/faq.md` | The same plan-level roster: `GLM-5.3`, `GLM-5.3-Flash`. |

## Why that is not the proof the issue asks for

Availability is published per subscription; destinations are published per protocol. Every page that
names Flash is making a plan statement, every page that names `/api/v1` is making a protocol
statement, and no published page joins the two. The one page specific to this endpoint declares a
two-model catalog without Flash — the same oracle the preset was built from, and the same one the
roster test locks.

The auto-switch line is the strongest single fact and it cuts both ways. Flash weights are already
reachable through this preset, because `glm-5-turbo` is in the shipped roster and the plan routes
that id to Flash. That is not evidence the endpoint accepts the literal id `glm-5.3-flash`, which is
what adding the roster entry would assert.

Metadata is the harder half anyway. Seeding a model means declaring a context window, modalities, a
reasoning ladder and a default effort. Every Flash number in this repository comes from the Z.AI or
BigModel Chat rows or a Command Code page scrape, none measured on `/api/v1`, and the two rows
already disagree where they overlap: `glm-5.3` is `1_048_576` on Responses and `1_000_000` on Chat.
Copying the Chat numbers across would publish a catalog entry nobody has verified.

## What would settle it

One authenticated `POST https://open.bigmodel.cn/api/v1/responses` with `model: "glm-5.3-flash"` on a
Coding Plan key, plus whatever the vendor publishes for that model's Responses context window and
modalities. A live credentialed probe was outside this round; #4210's author declined it for the same
reason. Until then the accurate product statement is the one already in the docs: this preset ships
the roster the vendor documents for it.

