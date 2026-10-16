# wp5 audit r1 — synthesis

Audit input is the maintainer-reviewer's incremental review of exact head `842170b6f` (Ingwannu,
2026-08-31): all three code blockers resolved, focused regressions meaningful, exact-head CI and the
service lifecycle matrix green. Residual: two documentation-boundary items and one review thread to
resolve. Verdict carried as **near-pass**; residuals are the whole of the B scope in 050.

Source verification for the doc sentences (read in this worktree):
- `src/images/plan.ts` `resolveXaiImageAuthToken`: Grok grant only when `authMode === "oauth"`, else API key.
- `src/images/artifacts.ts`: HTTPS-only (`:278`, `:313`), `redirect: "manual"` with 3xx rejected
  (`xai-client.ts:124-128`), `MAX_DOWNLOAD_BYTES` 50 MiB default (`:14`, `:281`, `:327`).
- Image-bridge precedence sentence already present and correct; mirror it into codex-integration.

