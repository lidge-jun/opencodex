# 030 — CLI layer: a renderer that actually prints the cost

Work-phase **wp4**. Depends on `010` (fields) and `020` (filters).

## Why not fix `summaryLines()`

`summaryLines()` is shared by `storage`, `memory`, `debug`,
`claude-inbound` and `injection`. Those are flat DTOs and the flattener suits
them. Deepening it to serve usage changes five other commands' output as a
side effect. Usage gets its own renderer; the shared helper is untouched.

## House style (surveyed, not invented)

The repository has **no** shared table helper. The established pattern is a
local dynamic-width `padEnd` builder, the clearest instance being
`formatAccountTable()` in `src/cli/account.ts:78-93`:

```ts
const widths = header.map((h, i) => Math.max(h.length, ...data.map(d => d[i]!.length)));
const line = (cols: string[]) => cols.map((c, i) => c.padEnd(widths[i]!)).join("  ").trimEnd();
```

Same shape appears in `account-main.ts:64`, `models.ts:306`. We follow it.
Also confirmed: **no ANSI colour** in command output anywhere in `src/cli`
(only `star-prompt.ts` and `interactive-confirm.ts`, both interactive chrome),
and no terminal-width probing. So: plain text, no colour, no width clamp.

## Wording comes from the GUI, verbatim where it exists

The GUI already made these naming decisions and users see both surfaces.
From `gui/src/i18n/en.ts`:

- `usage.cost.total` -> `"API list-price equivalent (this range)"`
- `usage.cost.disclaimer` -> `"Not a billing receipt. Subscription usage or provider credits may apply instead."`
- `logs.conversation.excluded` -> `"({unpriced} unpriced, {unmetered} unmetered excluded from ~$)"`
- `logs.col.estimatedCost` -> `"~$"`, `pws.col.cost` -> `"Est. cost"`

Cost values render as `~$` with 4 fraction digits, matching
`formatEstimatedUsdValue` (`gui/src/intl-formatters.ts:61`) and
`formatCostUsd` (`gui/src/provider-workspace/usage.ts:217`). Unavailable is
`—`. We reuse the *shape and wording*, not the GUI modules — `src/` must not
import from `gui/`.

The disclaimer is not decoration. This proxy is used heavily against OAuth
subscription plans where no per-request charge exists; a bare dollar figure
would be read as a bill.

## Output shape

```
Usage — today (2026-08-22), all surfaces, provider=xai

Requests   1,447
Tokens     178,521,375  (in 4,489,102 / out 1,283,441 / cached 172,748,832)
Est. cost  ~$12.3456    API list-price equivalent (this range)
           3,827 unpriced, 820 unmetered excluded from ~$

PROVIDER  REQUESTS  TOKENS       EST. COST
xai          1,447  178,521,375  ~$12.3456

MODEL     PROVIDER  REQUESTS  TOKENS       EST. COST
grok-4.6  xai          1,447  178,521,375  ~$12.3456

Not a billing receipt. Subscription usage or provider credits may apply instead.
```

Rules:

- Model rows are capped (top 10) with a `... N more (use --json)` footer, so
  a 45-model window stays readable.
- Day rows print only for multi-day ranges; `today` is one day and a
  one-row day table is noise.
- `--json` output is untouched apart from the additive fields from `010`/`020`.

## Flags

`--range` gains `today` and `1d`. `--provider <name>` and `--model <id>` are
new. Both forward to the query string built in `020`.

Note `--provider`/`--model` already exist on `ocx observe logs`
(`observe.ts:58-59`) with the same spelling and meaning, so the vocabulary is
consistent across the two commands rather than newly invented.

## Registration is three places, not one

This is where an incomplete patch fails CI:

| Surface | File | Why |
|---------|------|-----|
| Parser + error text | `src/cli/observe.ts` `USAGE` const `:15-25` | validation list and `rejectArgs` help |
| Per-command help | `src/cli/registry.ts` `usage` entry `:211-214` | `ocx usage --help` early-exits through `root.ts:40` |
| Top-level banner | `src/cli/help.ts:60` | `ocx --help` |

`tests/cli-registry.test.ts:107-129` asserts every visible command appears in
the banner, satisfied by `helpSrc.includes(entry.usage)` **or** a
`^\s*ocx\s+<name>` line. The banner line today is already shorter than the
registry usage string, so it passes via the regex arm. Keep it that way:
lengthening the registry usage string is safe, but the banner line must keep
starting with `ocx usage`.

Also note `help.ts:60` is already stale — it omits `--surface` and `--json`.
Bringing it in line is in scope for this phase.

## Testing convention

CLI suites stub the runtime dependency rather than the network: `usage()`
takes `deps: RuntimeApiDeps`, so a test supplies a fake and captures
`console.log`. The renderer is therefore extracted as a **pure**
`formatUsageReport(summary): string[]` and tested directly on a fixture
payload, with the command-level test only confirming wiring. Pure formatter
tests are how `doctor.ts` does it (`formatResponseTempLines` etc. at `:709`),
which is the same reason: printing is easy to test only when it is separated
from fetching.

## Accept criteria

1. `formatUsageReport()` on a fixture with priced models prints a non-zero
   `~$` per model row and per provider row.
2. A fixture where every request is unpriced prints `~$0.0000` **and** the
   excluded-count line — the two are distinguishable in the output.
3. `ocx usage --range today --provider xai` builds the query
   `?range=today&provider=xai` (assert on the stubbed request path).
4. `--range bogus` still errors with the usage text, and the error lists
   `today` among valid values.
5. `--json` output is byte-identical to the server payload (renderer bypassed).
6. Model table truncation activates past 10 rows and prints the `... N more`
   footer.
7. `tests/cli-registry.test.ts` and `tests/cli-help.test.ts` stay green.

## Verifier

`bun test tests/cli-registry.test.ts tests/cli-help.test.ts <new usage cli test>`
