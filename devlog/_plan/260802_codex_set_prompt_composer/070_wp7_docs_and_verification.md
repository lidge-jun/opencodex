# 070 — WP7: docs, locales, and the closing gate

## Docs

New page: `docs-site/src/content/docs/guides/codex-prompt.md`, plus **four**
locale copies: `ja`, `ko`, `ru`, `zh-cn`.

The docs site carries four non-English locales
(`docs-site/astro.config.mjs:63-68`); the **GUI** carries five, because it also
has German. An audit caught an earlier draft saying "five locale copies" while
listing four directories. The counts differ by surface and must not be
conflated: docs = 4 + English, GUI = 5 + English.

A new page must also be added to the sidebar with its four translations, in the
same shape as the entries at `astro.config.mjs:85-91`.

Contents:

1. What the prompt stack is — the layer table from `001` §1, in user terms.
2. The five-class taxonomy from `001` §4, in user terms: which layers have a
   switch, which are configured elsewhere, and which cannot be suppressed at
   all. Say plainly that `feature-gated` layers are reachable but not from this
   page, and that extension layers cannot be enumerated.
3. Custom layers: what they are, where they land (`developer_instructions`),
   what happens to text the user wrote by hand (preserved, never edited).
4. Presets: adaptations, not copies, with the reasoning from `002` §5.
5. Timing: new sessions, not running ones (`003` §3).
6. That opencodex reads **one** config layer out of eight (`003` §1), so the
   page reports this file's values, not the resolved Codex configuration.

Also update:

- `docs-site/src/content/docs/reference/configuration/` — the five toggle keys
  and `developer_instructions`, in the file where root keys already live.
- Any nav/sidebar entry naming "Codex Auth".

Astro's config lists locales explicitly; a page added to English only shows a
missing-translation state. Either all five docs variants (English + four), or an
explicit decision — and the `260802_docs_overhaul` unit already established that
as the standard. The GUI's six-locale rule is separate and stated below.

## Locale parity

`typecheck` catches missing GUI keys because every dictionary is
`Record<TKey, string>` (`004` §D). It does **not** catch a key that exists but
still holds English text. WP7 reads every `codexSet.*` string in all six GUI
locales (en, ko, ja, zh, ru, de) and confirms it is actually translated.

Korean copy follows the house rule: no translationese, no AI idioms, one
register throughout.

## Full gate

On the exact HEAD that closes the unit:

```bash
bun run typecheck
bun run test
bun run lint:gui
bun run privacy:scan
bun run build:gui
git diff --check
```

All six must pass. `build:gui` is included because this unit adds a stylesheet
and new components — a Vite build failure would not surface in typecheck.

## Acceptance — one row per ask item

| # | Ask | Proven by |
|---|---|---|
| 1 | tab renamed Codex Set | `030` tests 1-3 |
| 2 | current window → Multi-auth | `030` test 1 |
| 3 | Prompt section beside it | `030` test 2 |
| 4 | Logs-style left/right panels | `030` tests 4-6 |
| 5 | built-in layers switchable | `030` tests 8-9 |
| 6 | `+` adds custom layers | `050` tests 1-2 |
| 7 | built-in rows never deletable | `050` test 12 |
| 8 | custom rows: dialog, save, toggle, delete | `050` tests 1-5 |
| 9 | built-in dialog is read-only | `040` test 7 |
| 10 | **non-disableable layers cannot be turned off** | `040` test 2 **and** `020` test 5, both table-driven over `LAYER_INVENTORY`; `020` test 6 guards the partition |
| 11 | presets provided, Codex-compatible | `060` tests 1-6 |
| 12 | Theme deferred with steps recorded | `090` exists, nothing implemented |

Item 10 carries two proofs on purpose. A UI-only guarantee is a UI that looks
safe; an API-only guarantee is a boundary nobody exercises.

## Residual risk, stated rather than hidden

1. **Upstream drift.** Every key here is ≤ 4 months old and `001` §6 shows the
   surface still moving. A rename upstream makes a toggle silently ineffective.
   Mitigation: an absent key reads as unknown, never as false. Not a fix.
2. **Model compliance is unproven.** `002` needs-verification: static ordering
   is proven; whether a model obeys a custom layer contradicting its base prompt
   is not. The linter warns, it does not guarantee.
3. **We read one config layer of eight.** `003` §1. The field is named
   `defaultedUserValue` and the UI claims nothing more. Resolved-config
   reporting is deferred, not quietly approximated.
4. **Extension layers are not enumerable.** `001` class E. The API says
   `extensionLayersEnumerable: false` rather than implying a complete list.
5. **Shared key ownership.** `003` §4 — Codex may rewrite
   `developer_instructions` itself. An earlier draft called this non-blocking
   while having no concurrency mechanism at all; an audit was right to reject
   that. `010` now adds whole-byte revisions, a journal whose recovery refuses to
   touch an externally modified file, a tokenized cross-process lock, and a
   pre-rename hash guard. What remains genuinely residual: Codex can replace the
   file inside the rename window itself, which no user-space mechanism prevents.
   It is detected on the next read as `projection-stale` and surfaced as a
   Repair action, not silently absorbed.
6. **Byte equality is not Rust equivalence.** `010` carries one golden fixture
   parsed by the real `toml_edit`, run on demand. Between runs, the encoder's
   correctness rests on a restricted character set and a hand-written grammar
   matcher — strong, but not the same as continuous proof.

Risks 1 and 5 deserve a live re-check whenever opencodex bumps its supported
Codex version. None blocks the unit; all belong in the close-out.
