# The app's webview has no JavaScript dialogs

The reported symptom was the sidebar's proxy refresh orb: press it, nothing happens, no popup. It
is not that button, and it is not a permission.

## What the button does

The refresh orb beside the red power orb is `dash.codexRestart` — "Codex 모델 목록 새로고침" — and
its handler opens with a consent gate:

    if (!confirm(t("dash.codexRestartConfirm"))) return null;

Every outcome after that is delivered by `alert()`: success, nothing-running, partial, HTTP
failure, unreachable, timeout, malformed. The confirm is deliberate and documented — stopping an
app-server can interrupt a Codex turn that is running right now, so the click is where the user
gives that consent.

## Why nothing happens

The app embeds wry 0.55.1 under Tauri 2.11.6. Its `WryWebViewUIDelegate` implements exactly three
`WKUIDelegate` methods: the file open panel, the media capture permission request, and window
creation for a navigation action. A search of the whole crate for
`runJavaScriptAlertPanel`, `runJavaScriptConfirmPanel` or `runJavaScriptTextInputPanel` returns
nothing.

WKWebView does not display a JavaScript dialog when its UI delegate does not implement the matching
panel method. So inside the app `confirm()` returns `false` without ever drawing anything, and
`alert()` draws nothing at all. The handler takes its early return and the click is swallowed.
In a browser the same dashboard works, which is why this reads as "the app is broken" rather than
"the dashboard is broken".

## It is a class, not a button

13 `confirm` gates and 8 `alert` reports across the dashboard are inoperative inside the app.
Among them:

- the sidebar's red power orb — `dash.stopConfirm` — so **stopping the proxy from the app does
  nothing either**;
- removing a provider key, removing an account, removing a routing profile, deleting a custom
  model, hiding a model, switching provider account mode;
- uninstalling the tray helper from the startup page;
- the memory observability confirmation;
- every result message the Codex refresh would have shown.

Every one of these fails the same way: the user clicks, is silently declined, and sees nothing.
The destructive ones fail safe — nothing is destroyed — but the user cannot tell a refusal from a
no-op, and the two non-destructive ones (stop, refresh) simply never run.

## What this means for the unit

This is a third answer to "who owns the runtime", from an unexpected direction. The app is supposed
to become the owner, and the two controls that act on the runtime from inside the app — stop and
refresh — are both gated behind a dialog the app cannot draw. Any takeover consent prompt written
as `confirm()` would be auto-declined the same way.

So the consent surface has to be real UI rather than a platform dialog, or the shell has to supply
the delegate methods. That choice belongs in the plan, not here.

