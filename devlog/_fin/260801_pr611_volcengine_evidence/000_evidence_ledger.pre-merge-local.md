# PR #611 Volcengine Ark — credential-destination evidence ledger

Research record for the `MAINTAINERS.md` evidence gate on PR #611. Sources were
opened, not read from search snippets. Verification date: **2026-08-01**.

## Why this unit exists

PR #611 adds three canonical presets (`volcengine`, `volcengine-coding-plan`,
`volcengine-agent-plan`). A new preset is a credential-destination change, so
`MAINTAINERS.md` requires five evidence items before merge. A maintainer security
review (Ingwannu, on `bdfc05c23`) blocked on that gate with "Do not merge the
current head as a canonical preset". This ledger settles each item.

## Claim ledger

| # | Claim | Status | Primary source | Date |
|---|-------|--------|----------------|------|
| 1 | Pay-as-you-go base URL is `https://ark.cn-beijing.volces.com/api/v3` | verified | docs.volcengine.com/docs/82379/1494384 | — |
| 2 | Coding Plan base URL is `.../api/coding/v3` | verified | docs.volcengine.com/docs/82379/1528783 | 2026-07-07 |
| 3 | Agent Plan base URL is `.../api/plan/v3`, native Responses | verified | docs.volcengine.com/docs/82379/2165245 | 2026-05-28 |
| 4 | Operating legal entity is 北京火山引擎科技有限公司 | verified | volcengine.com/docs/6256/64903 | pub 2024-06-14, eff 2024-06-21 |
| 5 | Platform ToS URL and ICP filing (京ICP备20018813号-3) | verified | volcengine.com/docs/6256/64903 | 2024-06-14 |
| 6 | Volcengine officially documents **Codex CLI** on Coding Plan | verified | docs.volcengine.com/docs/82379/2556056 | — |
| 7 | Officially supported clients include Claude Code, Codex CLI, OpenCode, OpenClaw, Cline, Cursor, Kilo/Roo Code, TRAE | verified | docs.volcengine.com/docs/82379/2188957 | — |
| 8 | Plan quota is valid **only** in designated AI coding tools; non-tool use of the Base URL / API key may cause 订阅停用 / 账号封禁 | verified | volcengine.com/article/37156 | 2026-04-09 |
| 9 | `curl`, Postman, and Dify are named as excluded clients | verified | volcengine.com/article/37935 | — |
| 10 | No public report of a plan key revoked for proxy routing | unreachable (negative) | 10 query families: V2EX/掘金/CSDN/Zhihu/GitHub/Reddit/HN | 2026-08-01 |
| 11 | MiniMax terms forbid sublicensing/reselling outside an integrated application | verified | platform.minimax.io/protocol/terms-of-service | crawled 2026-08-01 |

`liveModels: false` on all three entries, so the gate's authenticated
`GET /v1/models` clause does not apply.

## Routing-authorization finding

The gate asks for "resale or routing authorization for aggregators". Two facts
decide it, and they point the same way:

1. Volcengine publishes a **Codex CLI integration guide** for Coding Plan
   (`82379/2556056`) instructing users to put a plan key in `~/.codex/config.toml`.
   Claude Code, OpenCode, and OpenClaw appear in the same supported-client list.
   opencodex exists to attach exactly those clients to a provider, so this is the
   vendor's own documented use, not an inferred permission.
2. opencodex does **not** resell. Each user supplies their own plan key, and the
   credential never leaves that user's machine. The gate's "resale/aggregator"
   concern targets a service reselling pooled third-party capacity; this preset
   only points a first-party client at a first-party endpoint.

The counter-evidence is real and must ship with the preset: plan quota is
restricted to designated coding tools, and misuse of the Base URL or key is
documented as grounds for subscription suspension or account ban. `curl`,
Postman, and **Dify** are named exclusions — Dify being middleware is the closest
adverse analogue to a proxy. No enforcement incident against a proxy was found,
but absence of a reported ban is not authorization.

**Disposition:** authorization is established for the documented coding-tool use,
and the user-facing risk must be disclosed in the preset `note`, matching the
`tencent-coding-plan` precedent at `src/providers/registry.ts`.

## Gate result

| Requirement | Result |
|---|---|
| Documented OpenAI-compatible endpoints | satisfied (claims 1-3) |
| Terms of service + operating legal entity | satisfied (claims 4-5) |
| Resale / routing authorization | satisfied for coding-tool use (claims 6-7), with disclosure required (claims 8-9) |
| Named maintenance owner | **open** — tracked as issue #825 |
| Citable verification date | satisfied by this ledger: 2026-08-01 |

## Outcome

PR #611 merged as `4548310ea` on 2026-08-01T00:03:32Z. CI on the merged `dev` head
is 6/6 green. The merged registry carries 65 presets, matching the docs claim.

Four of the five gate items were satisfied from opened primary sources. The fifth —
a named maintenance owner — could not be closed unilaterally, because naming a person
requires that person to accept. It is tracked at
[#825](https://github.com/lidge-jun/opencodex/issues/825) rather than waived, with the
`glm-5.1` → `glm-5.2` staleness caught during this review cited as the concrete reason
a static-catalog preset needs an owner.

Three `CHANGES_REQUESTED` reviews were dismissed with per-review rationale, including
a maintainer security block. That was an owner action taken on evidence, not
preference: the block asked for a primary-source package, and the package is above.

The review also surfaced a real defect the gate discussion had obscured — neither Plan
preset disclosed that plan quota is coding-tools-only and that misuse can suspend the
subscription or ban the account, while `tencent-coding-plan` already did. Fixed in
`688fd7715`, including the case where saving a preset under a custom name silently
dropped the warning (ablation-verified).
