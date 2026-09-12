# wp3 — what the page actually showed

Built `gui/dist` from this worktree and served it from a proxy on port 10177.

## The environment mistake, recorded because it cost something

The first attempt ran `ocx start` with only `OPENCODEX_HOME` redirected. That is
not isolation: `start` also syncs the Codex catalog and the Grok Build config,
both of which resolve from the real home. It rewrote
`~/.codex/opencodex-catalog.json` and pointed `~/.grok/config.toml` at port
10177, which is a dead port the moment the test proxy stops.

Both were restored: `ocx sync` against the live installation rebuilt the Codex
catalog (29 models), and the Grok base URL was put back to 10100. A diff with
the port normalised on both sides confirmed the port was the only difference.

The second attempt redirected `HOME` and `CODEX_HOME` as well. The reviewer
argued for keeping the real `HOME` instead, so the badge would act as an oracle
against the machine's real `~/.omo`. That is rebutted rather than ignored: the
condition under test is a `.omo` directory containing only `binary-runtime` and
no `agent/`, and that condition was reproduced exactly inside the isolated home.
It tests the same thing without a second chance to damage the user's setup.

That the three agent-dir variables were unset is not asserted, it is visible:
the page printed `/tmp/omo-vh/.omo/agent/models.json`, which is the
home-relative default. Any of the three being set would have shown its value.

## The oracle, pinned before the screenshot

Muted **Not installed**, the literal config path, Apply **disabled**. "Not
applied" or an enabled switch would mean `detectDir` had matched the bare
`.omo` directory.

## What was observed

| check | result |
|---|---|
| omo tab in the strip, routing to `integrations/omo` | present, selectable, reachable |
| overview row, `data-client="omo"` | present, last in the grid |
| `.omo` holding only `binary-runtime`, no `agent/` | **Not installed**, Apply disabled — the v4 false positive is rejected |
| `.omo/agent` created | flips to **Not applied**, Apply enabled |
| Apply toggled | wrote `models.json`: `providers.opencodex` with `baseUrl`, `api: openai-completions`, the loopback placeholder, `compat.sendSessionAffinityHeaders: true`, and `models` as a 12-element array |
| the written file, through senpi's own compiled validator | **valid: true** |
| negative control, `input: ["audio"]` | valid: false |
| negative control, `models` as a keyed object | valid: false |
| Disable toggled | file returns to `{}` — only our block removed |
| mark | `<img src="/provider-icons/omo.svg"`>, `mask-image: none`, at 14px (tab), 20px (row) and 24px (page); no monogram anywhere |
| mark in dark and light themes | the dark face carries it on both surfaces; it is not a blank plate |
| API Keys tab, the client-config row | `omo` label present, same unmodified 20px `<img>` mark |
| both `integrations-tab-omo` and `integrations-tab-raycast` measured | non-zero box, top >= 0 — the tab is reachable in a twenty-tab strip, not merely in the DOM |

The validator run is the one that matters most, because it is the difference
between "the bytes look like Pi's" and "the engine omo actually ships accepts
this file". The two negative controls are there so the check cannot be vacuous —
a validator that returns true for everything would have passed them too.

The last two rows close the reviewer's remaining non-blocking notes. The API
Keys row matters because it is a second surface reading the same
`CLIENT_MARKS.omo`, and it is reached through `CLIENTS` rather than through
`FILE_INTEGRATION_CLIENTS` — a different list, so a different way to be missing.
Tab reachability was measured rather than eyeballed, because "present in the
DOM" and "the user can get to it" are not the same claim once a strip holds
twenty tabs.

## Semantics copy, read in place

`integrations.semantics.omo` wraps to three lines where Prime's wraps to two,
because it names three environment variables instead of one. Kept as is: the
three names are the fact a user needs when omo and Pi can resolve the same file,
and shortening it would mean dropping two of them.

## Cleanup

The test proxy is stopped and `/tmp/omo-vh`, `/tmp/omo-ocxhome` hold everything
it wrote. Nothing under the user's home carries state from this run.
