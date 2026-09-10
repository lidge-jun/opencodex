# Codex Spark retirement UI evidence

Rendered from Cross-platform CI run **34671771774**, artifact **10291125984**:

- Build commit: `0a0fd2a225614fb0c80ad3e125dfa7243879c87b`
- GUI tree: `08717a046c2b2550c8ed08499511e5edc6aa2801`
- Dashboard route: `/#codex-set`, with synthetic local API data only.
- Desktop CSS viewport: 1440 × 1100; mobile: 390 × 844. PNGs retain native capture resolution.

Each screenshot was visually inspected before copying; none was retouched.

| Image | Observed state |
| --- | --- |
| [desktop.png](desktop.png) | Main and backup account cards, remaining controls, no Spark switch. |
| [desktop-refreshed.png](desktop-refreshed.png) | Refresh completed with success feedback. |
| [desktop-paused.png](desktop-paused.png) | Bulk pause affected only the exhausted backup; Resume remains available. |
| [mobile.png](mobile.png) | Responsive account panel after successful resume, without horizontal document overflow. |

The browser console was empty and fixture requests returned HTTP 200. This is UI evidence,
not live-account quota or entitlement validation. On mobile, long account/limit text wraps.
No live proxy, product build or local test suite was used. The fixture server was stopped after capture.
