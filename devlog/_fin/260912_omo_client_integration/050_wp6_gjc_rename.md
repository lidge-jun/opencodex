# wp6 — Gajae Code reads as gjc

The product shortened its name. The repository is `Yeachan-Heo/gajae-code`, the
published package is `@gajae-code/coding-agent`, the command is `gjc`, and the
config path this repo already writes is `~/.gjc/agent/models.yml` — the path
rebranded before the label did, which is why "Gajae Code" now sits next to a
`.gjc` directory in the same docs table.

## The line this phase does not cross

The client **id** stays `gajae`. It is not a caption: it is the key in
`EXPORT_CLIENTS` and `INTEGRATION_CLIENTS`, the segment in
`/api/client-integrations/gajae`, and the key an enable record is stored under.
Renaming it orphans the stored state of every user who already connected the
client — the integration silently reads "not applied", and the ownership record
no longer matches the block we wrote into their config, so a later disable can
no longer remove it cleanly. The user was asked and chose label-only.

`OPENCODEX_GAJAE_API_KEY` stays for the same reason: it is a variable a user has
already exported, and renaming it breaks a working setup silently.

## Surfaces that change

| file | from | to |
|---|---|---|
| `gui/src/i18n/*.ts` × 9, `integrations.tab.gajae` | `Gajae Code` | `gjc` |
| `gui/src/i18n/*.ts` × 9, `api.clientConfig.clientGajae` | `Gajae Code` | `gjc` |
| `src/cli/registry.ts` export summary | `Gajae Code` | `gjc` |
| `docs-site/.../guides/integrations.md` + translations | `Gajae Code` rows and prose | `gjc` |
| `docs-site/.../reference/cli/agents.md` + translations | `Gajae`/`Gajae Code` prose | `gjc` |
| `docs-site/.../reference/configuration.md` + translations | `Gajae` in the Fast-rows client list | `gjc` |

`gjc` is a product name, so it stays untranslated in all nine locales, which
means the two keys keep their places in `ZH_TW_KEEP_ENGLISH` and
`INTENTIONAL_ENGLISH` — they were already there under the old spelling, so this
is a value change, not a list change.

## What proves it

No test asserts the literal `Gajae Code`, and the two translation allowlists key
on key *names*, not values, so changing the value needs no list edit. The label
is never derived from the id — every surface reaches it through an i18n key — so
the two can honestly disagree.

The proof is `rg -n "Gajae"` restricted to **user-visible text**: the nine locale
catalogs, the CLI summary prose, and `docs-site`. A bare tree-wide search is the
wrong check and would report itself failing forever, because the internal
identifiers (`GajaeGeneratedConfig`, `gajaeConfigPath`, `buildGajaeClientConfig`,
`OPENCODEX_GAJAE_API_KEY`) are exactly what this phase is not touching.

## Verified after merge

An independent audit read `origin/dev` and ran that check against what actually
landed: zero `Gajae Code` across the nine locale catalogs, `src/cli/registry.ts`
and `docs-site`. Every surviving `Gajae` is an identifier, the
`OPENCODEX_GAJAE_API_KEY` env var, an i18n key *name* whose value is now `gjc`,
an internal type, or a comment. The line this phase promised not to cross held:
the client id is still `gajae`, the config path is still `~/.gjc/agent/models.yml`,
the route is still `/api/client-integrations/gajae`, the download filename is
still `gajae-models.yaml`, and the tab hash is still `integrations/gajae`. So an
install that had already connected the client keeps resolving its stored enable
record, which is the whole reason the id stayed put.

The audit did find one mention this plan had missed: the header comment in
`src/cli/export-command.ts` still said "Eight clients" and listed `Gajae` among
the YAML dialects. It was stale on both counts — there were thirteen clients
before omo — and it is corrected alongside the outcome note.
