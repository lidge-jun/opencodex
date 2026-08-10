# 070 — WP7: i18n, docs-site sync, hardening

Diff-level PRD. Depends on WP1-WP6. This is the closing phase: it makes the
surface speak six languages, tells users the truth in the docs, and runs the
full gate rather than the per-phase subset.

## Scope boundary

IN

- `gui/src/i18n/{en,de,ko,zh,ru,ja}.ts` — MODIFY. Scope narrowed by the round-2
  amendment below: the 78 shipped keys are already complete in all six, so the
  only addition is the missing `integrations.error.nonLoopback`.
- `gui/src/pages/integrations/refusal-copy.ts` — MODIFY. Mapping `non_loopback`
  in `reasonKey` is necessary but NOT sufficient: `describeRefusal` must also
  prefer the localized copy over the writer's always-present English message,
  or the new key never evaluates (see §1's round-3 correction).
- `docs-site/src/content/docs/guides/integrations.md` — NEW (English source);
  where a locale is not translated, no locale file is added and Starlight's
  default-locale fallback serves the English content at that locale's route
  (§2).
- `docs-site/astro.config.mjs` — MODIFY (sidebar entry for the new page).
- `src/cli/help.ts` — MODIFY (export usage/summary/details and the top-level
  line; see §3 for the full list of stale claims).
- `src/cli/export-command.ts` — MODIFY (file-header comment only; its usage
  string already derives from `EXPORT_CLIENT_IDS`).
- `tests/integrations-invariants.test.ts` — NEW (the §4 cross-cutting table).

**A-gate amendment (round 1):** the exact docs-site path above must be
re-verified at this phase's P against the then-current `docs-site/` layout
(LOOP-CONTINUITY-01); if Starlight's content root has moved, the plan follows
the tree rather than this line.

**P-phase stale check (round 2) — what WP5/WP6 already landed.**

The docs-site layout is unchanged: `docs-site/src/content/docs/guides/` holds
the English sources, locale variants live under `ko/`, `zh-cn/`, `ru/`, `ja/`,
and the sidebar is a flat `items:` array in `docs-site/astro.config.mjs` with
per-entry `translations`. The planned page and sidebar entry are still exactly
the right shape.

The **i18n table in §1 is superseded**. WP5/WP6 shipped 78 `integrations.*`
keys, identical in all six locales, but under different names than this
document guessed a phase earlier. Renaming live keys to match a stale plan
would be churn with a regression risk and no user-visible gain, so the plan
follows the tree:

| 070 §1 name | shipped name |
|---|---|
| `integrations.journal.expired` | `integrations.action.snapshotExpired` |
| `integrations.journal.empty` | `integrations.rollback.empty` |
| `integrations.refuse.conflict` | `integrations.error.conflict` |
| `integrations.refuse.nonLoopback` | **MISSING — must be added, see below** |
| `integrations.applyNote.<client>` | `integrations.semantics.<client>` |
| `integrations.caveat.comments` | *(docs-only — see below)* |

**Correction (A-gate round 2).** A first draft of this amendment claimed both
missing keys were unrenderable and cited C-ACTIVATION-GROUNDING-01. That was
wrong for `nonLoopback`, and the rule says the opposite of what it was used
for: the rule forbids shipping UI that cannot be reached, not adding copy for
a branch that IS reached.

`non_loopback` is reachable today. Pi, Kimi and Gajae are loopback-only, so
applying any of them against a non-loopback bind hits the refusal in
`writer.ts`, `describeRefusal` passes the writer's `message` straight through,
and `FileIntegrationPage` renders it. That message is English, written for a
server log, and it is what a Korean or Japanese user sees.

**Mapping `reasonKey` alone is NOT enough** (A-gate round 3). The formatter
opens with `const message = refusal.message || t(reasonKey(refusal.reason))`,
and the writer always sends a non-empty message, so the `t(...)` side never
evaluates. Adding the key and the mapping would produce a dictionary entry
that still never renders — the exact inert-key outcome the round-2 correction
was written to avoid. WP7 must therefore:

1. add `integrations.error.nonLoopback` to all six dictionaries;
2. map `non_loopback` in `reasonKey`;
3. change `describeRefusal` so a reason with localized copy PREFERS it over
   the writer's message rather than falling back to it, interpolating
   `refusal.clientId` where the sentence needs it;
4. assert the rendered non-English string, which is what catches (3) being
   skipped.

The comment caveat is genuinely different: nothing renders it, so it stays a
docs fact rather than a dictionary entry that no surface reads.

So WP7's remaining work is: the missing localized refusal above, the CLI prose
in §3, the cross-cutting tests in §4, the docs-site page in §2, and the full
gate in §5. The rest of the six-locale obligation in §1 is met and is
re-proven by `bun run build:gui`.

OUT

- No new features. A behavior change discovered here is a WP-amendment
  (LOOP-UNIT-CHAIN-01), not a silent extension.

## 1. i18n — the six-file obligation

`TKey = keyof typeof en` (005 §5), and every non-English dictionary is
`Record<TKey, string>`. So a key added to `en.ts` **breaks the build** until
all five others have it. That is the enforcement; this phase just does the work
deliberately instead of discovering it at typecheck.

Key groups (English + Korean given here as the source of tone; the other four
follow their existing register):

| Key | en | ko |
|---|---|---|
| `nav.integrations` | Integrations | 연동 |
| `integrations.tab.overview` | Overview | 개요 |
| `integrations.tab.keys` | API Keys | API 키 |
| `integrations.state.absent` | Not applied | 미적용 |
| `integrations.state.current` | Applied | 적용됨 |
| `integrations.state.stale` | Update available | 업데이트 필요 |
| `integrations.state.conflict` | Conflict | 충돌 |
| `integrations.state.unsafe` | Cannot verify | 확인 불가 |
| `integrations.state.notInstalled` | Not installed | 미설치 |
| `integrations.action.apply` | Apply | 적용 |
| `integrations.action.disable` | Disable | 해제 |
| `integrations.action.undo` | Undo | 되돌리기 |
| `integrations.action.restore` | Restore from backup… | 백업에서 복원… |
| `integrations.action.restorePoint` | Restore to this point… | 이 시점으로 복원… |
| `integrations.journal.expired` | Backup expired | 백업 만료됨 |
| `integrations.journal.empty` | No apply history yet | 아직 적용 기록이 없습니다 |
| `integrations.caveat.comments` | Comments in this file are not preserved | 이 파일의 주석은 보존되지 않습니다 |
| `integrations.refuse.conflict` | This file changed after opencodex wrote it | opencodex가 쓴 뒤 파일이 변경되었습니다 |
| `integrations.refuse.nonLoopback` | Remote binds need a key you must enter yourself | 원격 바인드는 직접 키를 입력해야 합니다 |
| `integrations.applyNote.openclaw` | Applies to the running gateway immediately | 실행 중인 게이트웨이에 즉시 반영됩니다 |
| `integrations.applyNote.hermes` | Applies to new sessions | 새 세션부터 적용됩니다 |
| `integrations.applyNote.gajae` | Applies to new sessions, or when you open /model | 새 세션 또는 /model을 열 때 적용됩니다 |
| `integrations.applyNote.kimi` | Applies on restart or /reload | 재시작 또는 /reload 시 적용됩니다 |

Apply / Disable / Undo / Restore — 적용 / 해제 / 되돌리기 / 복원 — remain the
canonical LIFECYCLE terms (004 §6): one operation, one word, in every locale.

**Amended (A-gate round 3):** the original "no fifth verb may enter the
dictionary" is withdrawn. It contradicted the shipped surface, which
deliberately carries Update and Settings alongside the four, and it was
unfalsifiable as a test — see §4's removal note. Distinct actions may have
their own words; what the rule protects is that the four lifecycle operations
are never renamed or given synonyms.

**Rule: `nav.api`, `nav.claude`, `nav.grok` are NOT deleted** in this phase.
They still label the sub-tabs. Deleting them would be a separate, riskier
change and the keys cost nothing.

**Activation scenario:** run `cd gui && bun run lint:i18n` and
`bun run build:gui`; a missing locale key is a compile error, which is the
observable proof the obligation is enforced rather than documented.

## 2. docs-site sync (SOT-SYNC-01)

`docs-site/` gets one new page under the existing guide structure:

- What the Integrations tab does, with the six file-toggle clients named and
  the four non-toggle surfaces explained: API Keys, Codex CLI, Claude and Grok
  Build. **(A-gate round 2: "four exception clients" was wrong — API Keys is
  not a client, and Codex is wired by the proxy service rather than by a
  config we own.)**
- The per-client table: config path, format, when the change takes effect,
  and whether the credential is an env reference or a loopback placeholder.
- The rollback contract in user terms: every apply backs up first; undo
  applies to the newest operation; restore asks before replacing later edits;
  10 backups per client are kept.
- The honest caveats: comments are not preserved for YAML/JSON5/TOML clients;
  **Pi, Kimi and Gajae** are loopback-only — none of their schemas has a place
  for the admission header a remote bind requires, so a generated config would
  simply 401 (A-gate round 2: "Kimi is loopback-only" named one of the three);
  OpenCode launched via `ocx opencode` takes its config
  from the launcher, not from disk (004 §4).

Translated locales must not contradict the English source. Where a locale is
not translated, no locale file is written at all: Starlight's default-locale
fallback serves the English content at that locale's route, which is safer
than a stub that can go stale silently.

## 3. CLI surface

`src/cli/export-command.ts` already derives its usage from `EXPORT_CLIENT_IDS`
(005 §1), so the six ids appear there automatically. **The claim that it
hardcodes `<opencode|pi>` is stale and is withdrawn (A-gate round 2);** only
its file-header comment still says so, which is a comment fix.

The stale prose is all in `src/cli/help.ts`, and there is more of it than this
section originally named. Every one of these is user-visible and wrong:

- the `export` entry's `usage`, which hardcodes `<opencode|pi>` where the
  command itself accepts six;
- its `summary`, "Print a client config (opencode, Pi) …";
- its `details` line claiming the config "references the client's env var" —
  Kimi carries the `opencodex-loopback` placeholder instead, because it cannot
  hold an env reference at all;
- the top-level help line, "Print an opencode/Pi config wired to the running
  proxy".

**Withdrawn (A-gate round 3):** the round-2 claim that the `--json` detail is
wrong for YAML/TOML clients. `--json` routes through `printData`, which
`JSON.stringify`s whatever it is given regardless of client; native
serialization applies to the human view and `--out`. The existing sentence is
accurate and stays.

`export-command.ts`'s file header needs the same treatment as the help text:
its two-client heading is stale, "the JSON leads" is false for the YAML,
JSON5 and TOML clients, and "every config carries an env reference" is false
for Kimi.

`ocx integration client` already has a subcommand help entry; what it lacks is
a top-level usage line.

A user reading any of these is told this feature supports two clients. The §4
matrix pins the result so the prose cannot drift back.

## 4. Cross-cutting hardening tests

These belong here rather than in an earlier phase because they assert
properties *across* the whole feature:

**Matrix replaced (A-gate round 2).** The original five were audited against
the tree: three duplicated coverage that already exists, one was unfalsifiable,
and one was wrong about its own subject. What follows is what is actually
missing. The reasoning for each removal is recorded below the table so the
next reader does not re-propose them.

| Test | Asserts |
|---|---|
| `every client registry agrees with every other` | exact SET EQUALITY across `EXPORT_CLIENT_IDS`, `INTEGRATION_CLIENT_IDS`, the GUI's hand-synced `CLIENTS`, `FILE_INTEGRATION_CLIENTS`, and `CLIENT_LABEL_KEYS` keys. Five lists of the same six ids, two of them maintained by hand across a bundling boundary that forbids importing the backend one |
| `no file content ever reaches the journal` | drive a REAL apply over a config carrying a unique sentinel string, then assert the sentinel is absent from the persisted `journal.jsonl`, and that the snapshot holds the exact pre-apply bytes INCLUDING the sentinel. The point is data minimization — the journal is metadata about operations, the snapshot is the one place a copy of the user's file belongs — not a permissions difference; both files are written 0600 |
| `every client survives a full lifecycle` | for all six: seed a config with pre-existing user values, apply, assert our fragment paths are present and every user value is unchanged, disable, assert our paths are gone and the user's document is semantically equal to the original. Covers JSON, YAML, JSON5 and TOML through their real serializers |
| `a loopback-only refusal is localized` | render the `non_loopback` refusal under a non-English locale and assert the user does not receive the writer's English `message` |
| `CLI help names every client it supports` | `ocx help export` and the top-level help mention all six ids and no OpenCode/Pi-only prose |

Removed, with reasons:

- *every registry client has a GUI label key* — as worded it compares labels
  only, which is the weakest of the five hand-synced lists; replaced by the
  set-equality test above, which is what "catches the tuple drifting"
  actually requires.
- *every state has a badge key* — `IntegrationStateBadge`'s map is
  `Record<VisualIntegrationState, TKey>`, so a missing state is a compile
  error and a test asserting today's six literals proves nothing a new state
  would not already break at build time.
- *no client config output contains a credential* — already covered, and more
  strongly, by `client-config-export-new-clients.test.ts`, which asserts it
  for all six clients across loopback and remote binds.
- *the four-verb vocabulary holds* — unfalsifiable as written. The shipped
  action set deliberately includes Update and Settings beyond the four verbs,
  so "no fifth verb" has no executable definition and the test would encode
  whatever the author decided that day.

## 5. Full gate (the phase's own accept criteria)

1. `bun run typecheck` — clean.
2. `bun run test` — full suite green (not just touched files).
3. `cd gui && bun test tests` — GUI suite green (root `bun run test` does not
   include it; 005 §5).
4. `bun run lint:gui` — clean.
5. `bun run build:gui` — succeeds (this is what actually proves the six
   locales are complete).
6. `bun run privacy:scan` — no new findings attributable to this unit.
7. Docs-site builds.

**Gate details (A-gate round 2, corrected round 3).** "Docs-site builds" is
not a command: `cd docs-site && bun install --frozen-lockfile && bun run
build`.

Locales that are not translated do not get a stale copy. Starlight's
default-locale fallback serves the English content at the untranslated locale
route; the sidebar `translations` map localizes only the navigation label and
provides no content fallback (round-2 attributed the fallback to the wrong
mechanism). Note also that every other English guide currently DOES have files
in all four locale directories, so shipping English-only is a deliberate
choice here rather than the tree's existing habit — say so in the PR instead
of implying precedent.

## 6. Definition of done for the whole feature

A reviewer can, on a clean checkout:

- start the proxy, open the GUI, land on Integrations, and see six clients
  with honest states (including `미설치` for absent ones);
- toggle one on, confirm the client's config gained exactly one provider
  block and every value the user already had is still there and equal;
- toggle it off, confirm the block is gone and the remaining document is
  semantically equal to the pre-apply one;
- hand-edit the file, confirm the switch locks and disable refuses;
- restore from the rollback center and get the pre-apply file back, byte for
  byte.

**Why "semantically equal" and not "byte-identical" (A-gate round 2).** The
writer parses the config into a document, mutates one key, and re-serializes
the whole thing. Formatting and comments therefore do not survive an apply for
the YAML/JSON5/TOML clients, and promising byte identity in a definition of
done would be a promise the implementation cannot keep — the existing test
that reads as "byte-identical" in fact compares parsed objects.

Exact bytes ARE recoverable, but through the snapshot, not through disable.
That is precisely why the snapshot exists, and it is the honest thing to tell
a user: disable preserves your settings, restore preserves your file.

## OPEN QUESTIONS

- Whether the docs-site page should carry the per-client "verified against
  version X" line. It is honest but goes stale; the alternative is a dated
  research link back to `002`. Recommend the dated link.
- Whether `nav.api`/`nav.claude`/`nav.grok` should eventually be renamed to
  `integrations.tab.*` for consistency — a cosmetic follow-up, not this unit's
  work.
