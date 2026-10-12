# 140 — Tray usage popup: rustfmt, React Doctor, and a native glass surface

The tray usage popup (#5452, carrying #5436 by JayYun98) is functionally complete and
running on macOS, but three things keep it from landing and from looking like the
WidgetKit widget it sits next to.

## What is actually wrong

**`desktop shell` is red on `cargo fmt --check`.** The conflict resolution left a
`matches()` body past the width limit and a double blank line before
`set_visibility`. Clippy and the Rust tests never ran because the format step gates
them.

**React Doctor reports nine blocking findings** at `blocking: warning`. The action is
configured with `comment: false`, `review-comments: false`, `commit-status: false`, so
the findings exist only in the run's job summary. Reproduced locally with the
repository's own pinned scan, `react-doctor@0.9.11 --scope changed --base origin/dev`:

| Rule | Location |
|---|---|
| `no-barrel-import` | `Tray.tsx:2` — `../i18n` re-exports from `./shared` |
| `no-set-state-after-await-in-effect` | `Tray.tsx:26` |
| `js-set-map-lookups` ×5 | `Tray.tsx:87` ×2, `Tray.tsx:153`, `tray-data.ts:80`, `:81` |
| `prefer-module-scope-pure-function` | `Tray.tsx:123` |
| `no-array-index-as-key` | `Tray.tsx:164` |

**The popup is an opaque `#202022` rectangle.** The widget beside it uses the system
material, rounded numerals, and `.secondary` labels; the popup uses flat hex fills and
hairline dividers everywhere. They do not read as the same product.

## Delivery

One branch, `codex/260921-tray-usage-popup`, one PR to `dev` (#5452), ordered commits.

### Native surface — `desktop/src-tauri/`

Tauri 2.11.6 exposes `WebviewWindowBuilder::effects(WindowEffectsConfig)`, so the
vibrancy needs no extra dependency. It does need two things the tree does not have
yet: the `macos-private-api` Cargo feature on `tauri` and `app.macOSPrivateApi` in
`tauri.conf.json`. Both are required because `transparent` on macOS is a private-API
surface, confirmed from `tauri-2.11.6/src/lib.rs`. The cost is real and worth naming:
it forecloses Mac App Store submission. This app ships as a Developer ID DMG, so the
door it closes is one we are not using.

Transparency and effects are applied on macOS and Windows only. Linux keeps the opaque
surface, because blur there belongs to the compositor and `window-vibrancy` documents
it as unsupported.

The page has to know which surface it got, or its CSS would punch a hole in an opaque
window on Linux. A `cfg`-derived constant drives both the builder and the
initialization script, so the two cannot disagree.

### Page — `gui/src/pages/`

Fix all nine findings at the root rather than suppressing them. The
`no-set-state-after-await-in-effect` case is the only one that needs judgment: the
effect already guards every write with `active()`, so the fix is to make the guard
legible rather than to add one.

Restyle to the widget's vocabulary: the system material behind a translucent panel,
rounded tabular numerals for the figures, secondary-tone labels, and dividers only
where a section genuinely changes subject.

## Acceptance

- `cargo fmt --check` clean; `desktop shell` green.
- The pinned React Doctor scan reports zero issues on the changed scope.
- Every job the pull_request event requested is green at the exact head, including
  the aggregate `ci`.
- A screenshot of the glass popup in the PR body, since the description mentions gui.
- After landing: close #5436 as superseded with credit; the `Co-authored-by` trailer
  for JayYun98 stays on the branch.

## Not run

Local `bun run test`, `test:changed`, `typecheck`, `build`, and `bun install` are out
of scope for this batch by standing instruction. `cargo fmt` and `cargo check` on the
desktop crate are run, under the local-build authorization given for the desktop app.
