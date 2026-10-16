# B7 — GUI bug fixes

Base: `dev` `429f4e0175` (after B6 #6069). Branch `codex/train3-b7`.

Previous D (B6): #5925 and #5977 landed. Scope note: the request covers bugs, and only enhancements must avoid the
GUI, so GUI bug fixes are in scope; earlier batches skipped them by a stricter reading.

| PR | Author | Change | Kimi | UI visible |
|---|---|---|---|---|
| #6025 | Ingwannu | Kiro device-login status reads get one bounded, cancellable operation (fetch, body, decode), so a stalled body can no longer hang the dialog or the finalizer | LAND; its test fails on dev | no |
| #6010 | Ingwannu | The provider deep-link test stops dispatching a second `hashchange` for a changed hash | LAND; flake from CI, not reproduced locally | no (test only) |
| #6007 | Ingwannu | With provider-table routing, the dashboard and the start/sync output warn that some mobile remote thread lists hide openai-tagged history (#5848 mitigation; the issue stays open) | APPROVE; two dev tests fail without it | yes: a hint under the authless or client-compaction switch |

The batch PR needs a screenshot for #6007. It is taken from this branch's proxy run with `HOME`, `OPENCODEX_HOME`
and `CODEX_HOME` all pointed at a temporary directory, so no real shell profile, Codex config or app integration is
touched, and uploaded through the `pr-assets` branch.

## Build and evidence

Carried: `960e482b9e` (#6025), `519b9d7676` (#6010), `b51e20ceb0` (#6007), each keeping Ingwannu's authorship.

Local proof at `b51e20ceb0`: typecheck, structure and privacy exit 0; `codex-inject` and `codex-inject-integration`
160 pass; the four GUI files (Kiro device login, provider deep link, vision sidecar dashboard, locale parity) 82 pass;
`gui` `tsc -b` exit 0.

Screenshot: a proxy from this branch on port 18477 with `HOME`, `OPENCODEX_HOME` and `CODEX_HOME` under a temporary
directory (the running proxy on 10100 kept client routing). Aside opened the dashboard, turned on "Open Codex without
signing in" in that temporary config, and captured the row; the image is `pr-assets` `e202d69d1e`
(`260927-train3-b7/remote-history-hint.png`). The temporary proxy was stopped afterwards.
