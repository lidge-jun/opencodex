# 020 — Claude Desktop toggle: design amendments over 050

`050_desktop_toggle.md` stays the diff-level source for the standard-mode pivot
order, the credential-cleanup contract, status classification, refusal copy, GUI
wiring, and the i18n keys. Its structural premises are replaced here; where this
document and 050 disagree, this document wins.

## Amendment 1 — the WP3/WP5 shared contract is narrower than 050 assumes

050's OUT section claims WP3 already owns `clientIntegrations["claude-desktop"]`,
`clientIntegrationEnabled`, `mutateClientIntegrationEnabled`, a four-client
union, required `desiredEnabled`, and a per-client flight. None of that four-client
contract exists. What exists after WP-B (this branch):

- `clientIntegrationsSchema` with `codex`/`grok` keys plus `.passthrough()`
  (`src/config.ts:986-989`) — so adding `"claude-desktop": z.boolean().optional()
  .catch(undefined)` is additive and old configs stay valid.
- Desired-state owner `setIntegrationEnabled` / read helpers in
  `src/codex/desired-state.ts` (Codex+Grok today; extend the id union).
- The native route union `"claude" | "grok" | "codex"`
  (`native-integration-routes.ts:31`) with typed success/refusal envelopes and a
  route-local single flight (`:199-224`). WP-C extends this union with
  `"claude-desktop"` and reuses the same envelope/flight pattern; no new
  coordinator is invented (mirrors 010 Amendment 1).
- **Envelope widening is explicit WP-C work.** The current envelopes carry no
  desired state on the server (`native-integration-routes.ts:42-76`) or in the
  GUI parser (`gui/src/pages/integrations/native-api.ts:20-46`), while 050
  requires `desiredEnabled` on every Desktop status, success, and post-commit
  refusal (`050:685-690`). WP-C adds `desiredEnabled: boolean` to the shared
  status/success envelope and to post-commit refusals for ALL clients (the
  field is derived from the same persisted read each route already does), and
  widens the GUI parser accordingly. Pre-commit refusals that never read config
  may omit it; everything after the intent read includes it.
- 050's `runClientIntegrationFlight(...)` call in the auto-apply diff
  (`050:757-783`) is replaced by: the route-local flight for HTTP callers, plus
  the two persisted-intent re-reads it already specifies (before `fetchAllModels`
  and immediately before the writer). The second re-read is the real guard; the
  flight is idempotency, not correctness.

## Amendment 2 — inspector first, writer never on the read path

Confirmed by the WP-A audit: current reads are non-mutating, but there is no
classifying inspector. WP-C adds `inspectDesktop3pConfigLibrary()` in
`src/claude/desktop-3p.ts` as the single read-only owner:

- absent library dir → `not_installed`; reads NEVER create directories or files
  (the writer's eager `mkdirSync` at `desktop-3p.ts:331-345` stays write-only).
- `_meta.json` present → resolve the applied id, prove the selected `<id>.json`
  exists and parses as an object, classify `standard` (`{}` / no
  `inferenceProvider`), `gateway_ours` (opencodex fingerprint current),
  `gateway_drifted`, `foreign`, `no_owned_state` (library exists but nothing we
  own — the OFF no-op case), or `broken` (selected file missing/unparseable).
- Typed unsafe handling per 050 (`050:704-715,1044-1054`): malformed
  `_meta.json` → `metadata_unreadable` refusal (never guess); an applied id that
  fails the safe-filename shape → refuse without touching the path (no
  traversal); multiple rows matching our fingerprint after an interrupted
  cleanup → the remover prefers the SELECTED opencodex row and reports the rest
  as residue; invalid `inferenceProvider`/credential-field shapes are split by
  ownership per `050:704-715`: a profile our fingerprint/metadata claims but
  whose provider or credential shape no longer matches is **`unsafe`** — it
  refuses convergence without any Desktop write and is never masked as
  `foreign`/`no_owned_state`; only a profile with NO ownership marker is
  `foreign` (a valid user-selected third-party profile). In neither case are
  field values parsed further or echoed into envelopes or logs.
- The official schema is verified current (Anthropic configuration reference,
  2026-08-06, Luna lane 1): configLibrary paths per-OS, `_meta.json` + sibling
  `<id>.json`, gateway fields, `supports1m`/`prefer1m`. Missing-selected-file
  behavior is officially UNVERIFIED → never leave `appliedId` dangling.

## Amendment 3 — OFF pivot and cleanup, unchanged from 050 but restated as the contract

1. OFF with `not_installed` or no owned state → successful idempotent no-op;
   desired OFF persisted; no filesystem footprint.
2. OFF with our applied profile → write+select a credential-free `{}` standard
   profile FIRST (new id, `_meta.json` updated atomically), THEN remove our old
   `<id>.json` and `<id>.json.bak`. Success requires both absent; residue →
   `cleanup_incomplete` refusal with paths only (never contents/credentials),
   desired stays OFF, old metadata row kept as the retry locator.
3. Enable direction: explicit CLI apply (`src/cli/claude-desktop.ts`) and
   management `/apply` persist desired ON (+ `desktopAutoApply` semantics per
   050) before writing.
4. Auto-apply (`agent-settings-routes.ts:131-150,518-528`) gains the gates from
   050: skip on desired OFF, `desktopAutoApply === false`, missing profile, and
   `not_installed`/`no_owned_state`/`foreign` library kinds; re-read persisted
   intent after the `fetchAllModels` await, immediately before the writer.

## Amendment 4 — GUI consumes the three-plus-one union

050's GUI diffs assume a WP3 four-client `native-api.ts` contract. Actual: the
runtime allowlists currently admit `claude|grok|codex`; WP-C extends them with
`claude-desktop` and the Desktop-specific refusal reasons
(`metadata_unreadable`, `cleanup_incomplete`, residual detail). Toggle lands in
`overview-clients.ts` `claudeDesktopRow` with desired state separate from
observed `applied`; `ClaudeDesktop.tsx` shows desired OFF honestly; six locales
get the exact keys 050 lists. A GUI screenshot is REQUIRED in the PR (gui is
touched).

## Test plan (per 050 IN, adjusted)

- `tests/desktop-3p-removal.test.ts` NEW: pivot order (standard profile selected
  before removal), crash-boundary residue → `cleanup_incomplete`, idempotent
  no-op OFF, `not_installed` reads create nothing (assert directory absent
  after status), interrupted-cleanup double-row preference.
- `tests/native-claude-desktop-toggle.test.ts` NEW: route union, persistence
  ordering (intent before artifacts), refusal envelopes, auto-apply suppression
  including the post-await re-read (in-process race).
- `tests/claude-messages-endpoint.test.ts` MODIFY (050 IN list, restored): prove
  Desktop OFF leaves the shared `/v1/messages` transport and health live —
  the toggle disables a client's lifecycle, never the proxy surface
  (`050:1092-1097`).
- Profile preservation stays binding: `src/claude/desktop-profile.ts`
  assignments/defaults are consumed unchanged (`050:92-95`); the standard `{}`
  profile is written by the remover path, not by re-deriving profile fields.
- `gui/tests/*` per 050 IN list; `bun run lint:gui` joins the battery.
- Broken-change check: mutate the post-await re-read guard → auto-apply race
  test goes red; restore → green.
