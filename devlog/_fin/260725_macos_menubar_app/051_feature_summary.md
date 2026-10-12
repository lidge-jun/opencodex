# 051 — Feature summary

The macOS companion now shares the proxy's canonical usage accounting across the menu bar
app, widget, and dashboard Usage companion section. The proxy owns the
`/api/usage/timeline` and `/api/companion/settings` contracts; `ocx companion` provides
matching read/write controls with `show`, `set`, and `reset` subcommands.

The menu bar app renders a settings-driven title, today metrics, model/account/provider
sections, and a timeline chart. It writes a privacy-safe snapshot for the WidgetKit
companion, which supports small, medium, and large families and links back to Usage.
The default menu bar headline is total tokens; the dashboard can switch it to requests,
cost, quota, or icon-only display.
