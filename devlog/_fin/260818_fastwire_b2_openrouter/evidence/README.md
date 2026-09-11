# Evidence — FastWire B2 (OpenRouter)

`010_logs_openrouter_priority_lower_bound.png` — Logs table with three seeded OpenRouter
requests on `openai/gpt-5.6-sol`, captured against a local proxy with a temporary
`OPENCODEX_HOME`:

| Row | Attempt outcome | Rendering |
| --- | --- | --- |
| `or-priority-confirmed` | upstream echoed `service_tier: "priority"` | `≥$0.1105` — priced at the standard rate but marked a floor, because OpenRouter publishes no bundled tier price and documents priority as higher cost |
| `or-priority-declined` | upstream echoed `service_tier: "default"` | `~$0.1105` — a real downgrade, so no floor marker |
| `or-standard` | no tier requested | `~$0.1105` |

All three totals match on purpose: without a bundled priority price every row is computed at
the standard rate, so the only thing that differs is whether the cost is presented as an
estimate (`~$`) or as a known lower bound (`≥$`). The marker matches the convention used by
the parallel xAI unit (#2072).
