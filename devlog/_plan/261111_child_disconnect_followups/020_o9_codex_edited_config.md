# O9 — disconnect after Codex edited config.toml

## Cause

`compareJournalState` (src/codex/journal.ts) accepts config.toml only when it equals the original snapshot or the first injected bytes (hash). Codex appends `[projects."…"] trust_level` blocks and notice flags; the restore is then partial forever.

## Rule

Inside one held Codex config write lock, after `restoreJournalState` reports incomplete:

- proceed only if the journal is verified, the profile is restored, there is no lock or ownership refusal, and config.toml is what changed;
- and the owned-field strip that `ocx restore` uses (`stripOpencodexConfigResult` with the journaled values) would change nothing — no marked or journaled base URL / realtime URL, no `opencodex` provider or table, no managed web_search or subagent defaults, no profile section.

Then config.toml is left byte-for-byte and the journal is removed: its only remaining use, a whole-file replay of the pre-injection snapshot, would delete the lines Codex wrote, so it is never safe to apply again. If any OpenCodex line remains, the journal is kept and the refusal names the file and the remaining OpenCodex settings, quoting only an allowlist of keys OpenCodex writes and fixed table labels (never values, continuation lines, or quoted table names), with the fix: remove each named key with its whole value and each named table with every line under it, then run `ocx disconnect` again. `ocx restore` is not named: on a connected Child it also stores Codex integration as off, and nothing here proves a later link turns it back on.

Not done here: stripping the remaining OpenCodex lines inside disconnect. `ocx restore`'s strip does that with history-provider handling, and folding it into disconnect is a follow-up decision.

## Tests

- positive: Codex-appended lines, no routing → disconnect completes, config.toml unchanged, journal gone.
- negative: Codex-appended lines plus a remaining OpenCodex line (journaled `openai_base_url` without its marker) → refused, config.toml unchanged, journal kept, message names `openai_base_url`, config.toml and the fix.
