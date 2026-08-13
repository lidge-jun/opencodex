# 130 — Phase 14: usage-log attempt persistence (PR #1093)

Credit: **Takashi Yamashiro**
(`Takashi Yamashiro <email from PR head>`), PR #1093.
Adoption: **adapted** — attempt recording kept, forgeable ingress spans dropped.

## Defect

Ordinary request attempts are not persisted, so the usage log cannot show what
was actually attempted; normalization also collapses explicit empty arrays,
losing the distinction between "no attempts" and "not recorded".

## Why adapted

The attempt-persistence half is useful and correct. The ingress-span half is
not safe as written: the endpoint reads a client-supplied correlation header at
the public admitted surface (`src/server/index.ts:957`), so **any admitted
client can forge a regex-shaped "guard-issued" ingress span**. Persisted
telemetry that an untrusted caller can shape is worse than absent telemetry —
it looks authoritative. That half waits for a trusted producer boundary.

## Change

File list read from `gh pr diff 1093` against `dev` = `e9d957bf6`.

| Path | Op | Content |
|------|----|---------|
| `src/server/responses/core.ts` | ADOPT (+13) | Create the ordinary request attempt after final adapter resolution, using the existing attempt owner (anchor located by symbol — phases 050/060/070 also edit this file) |
| `src/server/request-log.ts` | ADOPT (+24/−~3) | Use the existing attempt owner; no new writer |
| `src/usage/log.ts` | ADOPT (+15/−~1) | Preserve explicit empty arrays through normalization |
| `src/server/index.ts` | DROP (#1093: +3) | The client-supplied correlation-header read at the public admitted endpoint — this is the forgeable-span surface |
| `tests/request-log.test.ts` | ADOPT (+41) | Attempt row presence after resolution |
| `tests/usage-log.test.ts` | ADOPT (+37) | Empty-array preservation |
| `tests/server-auth.test.ts` | DROP (#1093: +14/−~1) | Covers the dropped ingress-span header path |

## Verification

- `bun test` on the usage-log and request-log suites
- `bun run typecheck`
- `bun run privacy:scan` (must stay green — no account identifiers in the log)

## PR

Stack 13, base = stack 12 head. Credits Takashi Yamashiro and explains the
security reason the ingress-span portion was withheld.
