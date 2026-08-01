# 160.13 — Bugfixes: Version, Logo, Lazy-Loaded Models

- **Status:** Done
- **Date:** 2026-06-20
- **Work class:** C2 (small, localized; one server read + GUI)
- **Source:** user report (3 issues after the redesign)

## Issues & fixes

### 1. Version showed `0.0.1`, not the npm release (1.9.5)
`VERSION` was a hardcode in `src/server.ts:35`, and the GUI brand badge hardcoded `v0.0.1`.
- **Server:** read `version` from the root `package.json` at runtime
  (`new URL("../package.json", import.meta.url)`) → `/healthz` + the Dashboard VERSION stat now
  report the real installed version.
- **GUI:** `gui/vite.config.ts` `define: { __APP_VERSION__: <root package version> }` (baked at
  build; gui builds with the package via `prepublishOnly → build:gui`); `gui/src/vite-env.d.ts`
  declares the global; `App.tsx` brand badge renders `v{__APP_VERSION__}`.
- Verified: fresh instance `/healthz` → `"version":"1.9.5"`; GUI badge + stat show `1.9.5`.

### 2. Logo disappeared in light mode
`logo.png` is a **white** silhouette (alpha) — fine on the old dark-only theme, invisible
white-on-white once light mode landed. Fix: render it as a CSS **mask** colored by `--text`
(`.brand-logo`, `gui/src/styles.css`) so it adapts — off-black in light, near-white in dark —
with no new asset and no media query. `App.tsx` `<img>` → `<span className="brand-logo">`.
Verified visible in both themes.

### 3. Provider models "evaporated" in the Models settings page
Provider models resolve lazily (live `/models` + OAuth tokens). A provider not ready on the
first `/api/models` (e.g. anthropic right after login) was missing, and the Models page loaded
the list **once** with no refresh → it stayed missing until a manual remove/re-add. The data was
always correct (`/api/models` returns anthropic 10 + opencode-go 20). Fix: `Models.tsx` re-polls
`/api/models` every 10s, guarded by a `busyRef` so it never clobbers an in-flight toggle PUT.

## Files
- `src/server.ts` — version from package.json.
- `gui/vite.config.ts`, `gui/src/vite-env.d.ts` — build-time version inject.
- `gui/src/App.tsx` — brand logo span + injected version.
- `gui/src/styles.css` — `.brand-logo` mask (replaces `.brand img`).
- `gui/src/pages/Models.tsx` — guarded re-poll of the model list.

## Verification
- `bun x tsc --noEmit` exit 0; `gui bun run build` clean.
- Fresh proxy: `/healthz` → 1.9.5; screenshots (light + dark) confirm visible logo, `v1.9.5`
  badge + stat, and grouped anthropic/opencode-go models.

## Follow-up (noted, not done)
- `favicon.png` is likely the same white silhouette — may be faint on light browser tabs. A
  dark-mode-aware favicon (`<link media>`) is a possible later polish.
- The Dashboard model list also loads once; it benefits from tab re-mount but could share the
  same poll if cold-load gaps recur there.
