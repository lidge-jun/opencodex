# 260930 desktop external links — plan

## Conclusion

Links the loopback dashboard asks to open in a new window (OAuth "didn't open?" fallback,
device-code verification links, `window.open`) now leave the desktop app through one Rust
handler that hands http/https URLs to the OS default browser. Nothing new is granted over IPC.

## Problem

User report: pressing a login button in the desktop app often does not open the default browser.

Two read-only gpt-6.1-sol lanes and direct reads of the pinned crates (tauri 2.11.6, wry 0.55.1,
tauri-plugin-opener 2.5.3) agree:

1. The server-side launch (`/api/oauth/login` -> `openUrl`) is intact for browser flows, but its
   result is discarded, and device-code flows (Copilot, Kimi, Nous, Meta Muse, Kiro, Codex device)
   never launch server-side by design. Both depend on the GUI's `target="_blank"` link.
2. `tauri_plugin_opener::init()` injects a click listener that `preventDefault()`s every `_blank`
   click and invokes `plugin:opener|open_url`. The dashboard is the remote origin
   `http://127.0.0.1:*`; its capabilities (`dashboard-titlebar.json`, `dashboard-zoom.json`) grant
   no opener permission, so the IPC is denied after the click was already cancelled: nothing opens.
3. No webview installs `on_new_window`. Without it wry drops `window.open` on WebView2
   (`SetHandled(true)`) and WebKitGTK (no `create` handler); WKWebView only reaches the browser
   because its navigation policy sees the URL first.

## Options considered

- A. Grant `opener:allow-open-url` to the remote dashboard origin. Fixes anchors only, leaves
  `window.open` broken on Windows/Linux, and widens the IPC surface of a remote origin.
- B (chosen). Disable the plugin's JS interceptor (`open_js_links_on_click(false)`) and install an
  `on_new_window` handler on the main window and the tray popup that opens http/https in the default
  browser and returns `NewWindowResponse::Deny`. One decision point in Rust, no new grant, covers
  both anchors and `window.open` on all three platforms.

## Diff-level plan

- `desktop/src-tauri/src/window.rs`: extract `opens_in_default_browser(&Url)` (http/https only)
  and `open_in_default_browser`; reuse it in `navigation_allowed`; add
  `open_new_windows_in_default_browser<R>()` returning the handler; unit test for the scheme filter.
- `desktop/src-tauri/src/lib.rs`: build the opener plugin with `open_js_links_on_click(false)`;
  add `.on_new_window(...)` to the main window builder.
- `desktop/src-tauri/src/popup.rs`: add `.on_new_window(...)` to the tray popup builder, and open
  external http/https URLs in `popup_navigation_allowed` before refusing them. Audit round 1 (FAIL)
  found that WKWebView consults this policy before it would create a window for a `_blank` link, so
  a refusal without opening kept the popup's external links dead on macOS; round 2 passed.

Bundled pages (`desktop/ui`) contain no `_blank` anchors or opener calls, so disabling the
interceptor removes nothing they relied on. `mailto:`/`tel:` were never reachable from the
dashboard (same denied IPC) and stay out of the external-open filter.

## Verification

Same steps as the CI `desktop` job: placeholder sidecar and resource files (gitignored), then
`cargo fmt --check`, `cargo clippy --all-targets -D warnings`, `cargo test` for
`desktop/src-tauri`. Exact-head PR CI is the merge gate. A packaged-app click test is not
available locally; the behavior claim rests on the pinned wry/opener sources cited above.

## Outcome

Implemented as planned plus the audit fold in `popup.rs`. Local proof on macOS arm64:
`cargo fmt --check`, `cargo clippy --all-targets -D warnings` and `cargo test` (190 passed,
including `only_web_addresses_are_handed_to_the_default_browser`) exit 0; the desktop,
release-contract and repo-hygiene Bun suites (24 files, 334 pass, 2 platform skips),
`privacy:scan` and `structure:check` pass. Windows and Linux behavior is source-reviewed
against wry 0.55.1 and covered by the hosted desktop CI job, not by a packaged click test.

What this does not change: server-side `openUrl` still discards its launch result, and
device-code logins still do not auto-open a browser; both remain separate follow-ups.
