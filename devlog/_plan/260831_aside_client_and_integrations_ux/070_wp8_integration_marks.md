# wp8 — one mark, every Integrations surface

Depends on wp7: the shared component is only worth building once every client
has an asset, otherwise half the surfaces render monograms and the change looks
like a regression.

## The problem

`ClientConfigRow.tsx` is the only surface that draws a mark, and it owns the
img-versus-mask decision inline:

```tsx
{mark ? monochrome ? <span className="awi-clientconfig-mark-mask" style={{maskImage: ...}}/>
      : <img src={mark} alt="" width={20} height={20} />
      : <span className="awi-clientconfig-monogram">{label.slice(0, 1)}</span>}
```

Copying that ternary into three more files would put the invisibility rule in
four places, and the rule is exactly the thing that was already got wrong once.

## New module: gui/src/components/ClientMark.tsx

One component, one decision. Props: `markId` (the asset key, not the client id),
`label` (for the monogram letter), `size`, and `className`.

It reads from a new shared map rather than `CLIENT_MARKS`, because the
Integrations page needs marks for four clients that are not export clients at
all — `codex`, `claude`, `claudeDesktop`, `grok`. Those are different id
namespaces that happen to overlap on strings like `claude`.

## New module: gui/src/components/integration-marks.ts

`INTEGRATION_MARKS: Record<OverviewClientId | "keys", string | null>` mapping
every Integrations row to an asset already committed:

- `codex` -> `/provider-icons/openai.svg`
- `claude`, `claudeDesktop` -> `/provider-icons/claude-color.svg`
- `grok` -> `/provider-icons/grok.svg`
- the twelve file clients -> the same assets `CLIENT_MARKS` uses

None of the three non-file marks is masked, and the audit caught the plan being
wrong about two. `openai.svg` is a single fill, but that fill is `#10A37F` —
OpenAI's own green, the brand itself, which is exactly the `dsh` case
`client-config-clients.ts` already documents. Masking it would repaint a
trademark in the theme's text color. `grok.svg` is `#000000`, a genuine neutral
and therefore a real masking candidate — but it is xAI's published asset with a
literal fill, and rewriting it to `currentColor` is a change to someone else's
mark rather than a rendering decision. It stays an image and the dark-theme
contrast problem is recorded rather than papered over.

So `MONOCHROME_INTEGRATION_MARKS` is exactly `MONOCHROME_CLIENT_MARKS`' assets
and nothing more. Keying it by ASSET PATH rather than client id is the one
improvement worth keeping from the original sketch: `kimi-color.svg` is reachable
as both a provider icon and a client mark, and a path-keyed set cannot mask it
on one surface and leave it unmasked on the other.

## Surfaces

`IntegrationsOverview.tsx` — `OverviewCard` puts a `<ClientMark>` before the
`<h4>`, inside `.integration-card-head`. It is `aria-hidden`: the card's
accessible name is the title button, and a mark that joined the name would read
"Claude Claude".

`Integrations.tsx` — each tab button gets a 16px mark before its label. The tab
strip is 17 items on one row, so the mark is the thing that makes it scannable;
this is where the change pays for itself.

`FileIntegrationPage.tsx` — a 24px mark in `.integration-client-head`, before
the `<h3>`.

`ClientConfigRow.tsx` — the inline ternary is deleted and replaced by
`<ClientMark>`. Behavior is identical, which the existing panel test asserts.

## The Codex label

`integrations.tab.codex` is `"Codex CLI"` in all nine locales. With a mark
beside it the "CLI" is redundant, and the row covers the Codex app and SDK too,
so it is also slightly wrong. It becomes `"Codex"` in every locale. `ja`, `zh`,
`zh-TW`, `ko`, `ru`, `tr`, `de`, `fr`, `en` all currently hold the literal
string `Codex CLI`, so this is one substitution per file.

`integrations.codex.title` and `.body` are separate keys and are left alone;
they describe the routing behavior, where "CLI" is accurate.

## CSS

`gui/src/styles-apikeys-workspace.css` keeps `.awi-clientconfig-mark`; the new
component emits `.client-mark` plus `.client-mark--mask` / `.client-mark--img`
/ `.client-mark--monogram`, sized from a `--client-mark-size` custom property
so one rule serves 16/20/24/28px. The mask branch reuses the existing
`background: var(--text)` treatment.

## Tests

Extend `gui/tests/integrations-surfaces.test.tsx`: each of the three surfaces
renders a mark element per row/tab/header. Driven red by omitting the tab-strip
mark.

New guard: every id in `INTEGRATION_MARKS` has a value, and every value resolves
to a committed file. Falsify by pointing one at a missing asset.

New guard: `MONOCHROME_INTEGRATION_MARKS` contains no asset whose file has more
than one distinct fill. Falsify by adding `claude-color.svg`.

New guard, from the audit: no asset whose single ink is a BRAND color may be
masked. `openai.svg` (`#10A37F`) and `deepseek-harness.svg` (`#4d6bfe`) are pinned
by name with their inks, the way the existing `dsh` test does, because no
property of the file distinguishes a brand ink from a neutral one. Falsify by
adding `openai.svg` to the mask set.

New guard: no mark element contributes to an accessible name — each is
`aria-hidden` or has an empty `alt`. Falsify by giving the img an `alt={label}`.

New guard: no locale contains `Codex CLI` under `integrations.tab.codex`.
Falsify by reverting one locale.

## Verification

`cd gui && bun test tests` focused files, plus headless Chrome screenshots of
`#integrations` at 1280 and 390 wide in both themes. The screenshots are the
only thing that proves the tab strip still wraps sanely with 17 marks in it.
