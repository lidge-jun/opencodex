# 030 — Layer 3: docs

Branch codex/cursor-integration-docs (base codex/cursor-integration-tab). PR 3 of 3.

guides/cursor-private-inference.md: add "From the dashboard" after "Configure the gateway":
the Integrations > Cursor tab detects the build, shows the two values with copy buttons and
the last request seen from Cursor, and never writes Cursor's settings. Update the Cursor
paragraph in guides/integrations.md to point at the tab. Verifier: cd docs-site && bun run build.

## Stale check (P, after wp3 landed as da5d74b00; amended after audit round 1)

- Guide sections today: Before you start / Configure the gateway / Models and reasoning effort /
  Verify. "From the dashboard" goes between Configure the gateway and Models and reasoning effort.
- integrations.md line 62 "Cursor is not on this list" is now wrong. Rewrite it: Cursor has a tab,
  but it is read-only (not one of the managed switches) — it detects the two builds, shows the
  gateway values, and reports the last request. Also add a Cursor sentence to "The other four
  surfaces are not switches" (rename heading count: five) so the read-only surfaces list is complete.
- Locale copies: `cursor-private-inference.md` has none. `integrations.md` exists in fr, tr, zh-tw
  (none mention Cursor today). Add the same "not a switch" Cursor sentence to each, in that locale,
  in the corresponding section (fr ~L66, tr ~L74, zh-tw ~L45), AND rename that section's heading
  from "four" to "five" in each locale (fr L64, tr L71, zh-tw L43) to match the English change.
- "From the dashboard" must describe the shipped page exactly: (1) Installed builds — Private
  Inference vs regular, with the tunnel note when only regular is found; (2) Gateway values — Base
  URL always has Copy; API Key is a Copy of `opencodex-loopback` only when the bind needs no
  credential, otherwise the card says to use one of your opencodex API keys and links to the API
  Keys tab (this reconciles the narrower `OPENCODEX_API_AUTH_TOKEN` row above: any configured API
  key works); (3) Connection — last `/v1/models` request whose User-Agent starts `Cursor/`; the
  Refresh model list button in Cursor is what makes it flip from "never seen"; refreshes every 15 s
  while the tab is open; (4) What Cursor will show — Model / Reasoning / Context table, a prediction;
  (5) guide link. The tab never writes Cursor's settings, database or keychain.
