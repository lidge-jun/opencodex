# wp4 — documentation

Two pages carry the client list, and both have translated copies that commit
`42adf4996` established are synchronized rather than allowed to drift.

`docs-site/src/content/docs/reference/cli/agents.md`
: the `--client` union, the flag table, and the destination table. Translated
  copies exist under `fr`, `ja`, `ko`, `ru`, `tr`, `zh-cn`, `zh-tw`.

`docs-site/src/content/docs/guides/integrations.md`
: the client table. Translated copies exist under `fr`, `tr`, `zh-tw`.

The omo row names the destination `~/.omo/agent/models.json`, the download
filename `omo-models.json`, and the loopback-only stance with its reason, in the
same voice the neighbouring rows use.

The Aside unit found the integrations guide missing a `zcode` row. wp4 re-checks
that every registered client is present in both tables before adding omo, so a
new row does not land next to a known hole.
