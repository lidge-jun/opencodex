# 030 — Layer 3: docs

Branch codex/cursor-integration-docs (base codex/cursor-integration-tab). PR 3 of 3.

guides/cursor-private-inference.md: add "From the dashboard" after "Configure the gateway":
the Integrations > Cursor tab detects the build, shows the two values with copy buttons and
the last request seen from Cursor, and never writes Cursor's settings. Update the Cursor
paragraph in guides/integrations.md to point at the tab. Verifier: cd docs-site && bun run build.

