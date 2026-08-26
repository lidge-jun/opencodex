# FastWire B2 (xAI) — UI evidence

`010_logs_priority_lower_bound.png` — Logs & Debug, three seeded `xai/grok-4.6` rows
that exercise every branch of the new pricing path:

| Row | Situation | Cost cell |
| --- | --- | --- |
| `req-standard` | no Fast requested | `~$0.0300` |
| `req-priority` | response-confirmed priority, prompt under the long-context threshold | `~$0.0600` — exactly the documented 2x premium over the row above |
| `req-longctx-priority` | response-confirmed priority, prompt at or above 200k | `≥$0.8760` — the published long-context rate, marked a lower bound because xAI publishes no combined price |

The `≥` prefix is the visible change: a cost that is a known floor rather than an
estimate now says so instead of rendering as `~$`. The detail drawer explains why
via the `priority_lower_bound` estimate reason.

Captured against a local proxy with a seeded `usage.jsonl`; no live xAI request was
billed to produce it.
